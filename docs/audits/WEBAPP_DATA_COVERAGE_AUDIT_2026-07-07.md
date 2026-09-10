# Webapp ↔ Database Data-Coverage Audit (Industry-Standard Benchmark)

**Date:** 2026-07-07
**Auditor:** Claude (three parallel code sweeps — ops-console page/field map, auth-service route×table map, messenger-service persistence map — reconciled against the live Supabase schema: `information_schema` column inventory, `pg_stat_user_tables` row counts/sizes, migration ledger, storage buckets, and security/performance advisors)
**Scope:** The full webapp (`apps/ops-console`, Next.js 15 App Router) audited against **every table in the production database** (91 tables, `public` schema) and the two backing services (`apps/auth-service`, `apps/messenger-service`). Question under audit: _does all the data we hold reach the webapp, to industry standard?_
**Prior art:** `OPS_CONSOLE_AUDIT_2026-07-06.md` scored code quality/security (70/100, P1/P2 remediated same day). This audit is orthogonal: it scores **data coverage, data governance, and data-access UX**.

## Overall Score: 61 / 100 → post-remediation ~82 / 100 (see Remediation status below)

The backend API is broad (≈63 of 91 tables have a live read/write path) and the E2EE boundary is handled correctly — message content, backups, and vault data are _rightly_ invisible to the console. But the webapp itself surfaces only about a third of the data the platform holds. Three whole domains with real production rows — **finance ledger, disputes, VBG protection monitoring** — have no operator surface at all, two admin workflows are **dead-ended** (a write/verify path exists but no way to discover the records), there is **no user administration** for 127 registered users, and 4 tables sit exposed with **RLS disabled** (Supabase ERROR-level). Layered on top: hardcoded list caps with no pagination make older rows unreachable, and 16 legacy tables (18% of the schema) are dead weight.

| Dimension                           | Score | Headline                                                                         |
| ----------------------------------- | ----- | -------------------------------------------------------------------------------- |
| API completeness (DB → API)         | 72    | ~63/91 tables reachable; but disputes/armed-auth lists missing, audit write-only |
| Console coverage (API → UI)         | 55    | 34/91 tables surfaced; Finance/Analytics/Messenger pages are stubs               |
| Financial data governance           | 50    | Full double-entry-style ledger in DB, zero reporting UI; blind wallet adjust     |
| Data lifecycle & retention          | 68    | Relay/archive/media sweeps solid; auth cruft, unbounded backups, stdout audit    |
| Schema health & security posture    | 60    | 4 RLS-disabled ERROR tables, public bucket listing, 16 dead tables, dup index    |
| Data-access UX vs industry standard | 55    | No server pagination/cursor, no global search, CSV export on 1 page only         |

---

## Remediation status — 2026-07-07 (same day)

**All P1s and P2s fixed, plus the cheap P3s.** Gates green: auth-service `tsc` clean + full Jest suite **94/94 suites (1,663 tests)**; ops-console `tsc` clean + `next lint` clean + production build. Deployed to Contabo staging via the push-to-main pipeline.

| Finding                        | Status                     | What shipped                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DC-01 Finance dark             | ✅ fixed                   | `/ops/finance/*` read APIs (transactions/escrows/payouts/invoices/promos/per-user wallet) + Finance page rebuilt with 7 tabs (LEDGER incl. CSV export, ESCROW, PAYOUTS, DISPUTES, INVOICES, PROMOS, ADJUST). Adjust form now shows the target user's balance + recent ledger before any confirm — no more blind adjust.                                                                                                   |
| DC-02 Disputes dead-ended      | ✅ fixed                   | `GET /ops/disputes` (region-scoped, escrow-joined) + DISPUTES tab with the resolve flow (split + resolution, SUPERVISOR+).                                                                                                                                                                                                                                                                                                |
| DC-03 Armed permits dead-ended | ✅ fixed                   | Pending `armed_authorizations` now ride `/ops/compliance/pending` (`armed:true` rows); new `POST /ops/armed/:id/reject`; Compliance page routes armed rows to the armed verify/reject endpoints with an ARMED badge.                                                                                                                                                                                                      |
| DC-04 No user admin            | ✅ fixed (read + sessions) | `/ops/users` list/detail (SUPERVISOR+) + `/users` directory page (search, role/kyc filters, load-more) + user detail (Redacted PII, wallet, bookings, agent link) + per-device session revoke (`auth_devices.revoked_at`, audited). **Deferred:** account suspension/erasure semantics — changes the auth flow (documented stop-condition); needs an architecture decision. `users.deleted_at` remains unset by any flow. |
| DC-05 RLS disabled ×4          | ✅ fixed                   | Migration `webapp_audit_rls_bucket_index_hygiene`: RLS enabled on promo_codes, promo_redemptions, invoices, invoice_sequences. Advisor ERRORs cleared.                                                                                                                                                                                                                                                                    |
| DC-06 No SOS log               | ✅ fixed                   | `GET /ops/sos` (incl. mission-less panics, active-first) + `/sos` page with ack/escalate/resolve actions; nav entry SOS Log.                                                                                                                                                                                                                                                                                              |
| DC-07 VBG dark                 | ✅ fixed                   | `GET /ops/vbg/monitoring` (heartbeat health + watchdog escalations + latest SRA) + read-only `/vbg` page with escalation highlighting.                                                                                                                                                                                                                                                                                    |
| DC-08 Audit write-only         | ✅ fixed                   | `GET /ops/audit` global browser (keyset-paginated, SUPERVISOR+) + `/audit` page (filters, LOAD OLDER, CSV export); `agent_audit` now surfaces on agent detail (`state_audit`); `GET /ops/audit/org/:orgUserId` reader for `org_audit_log`. Vault access log → durable store remains messenger-service backlog (stdout today).                                                                                             |
| DC-09 Caps without paging      | ✅ fixed (bounded)         | `?limit=` (≤500) on bookings/agents/completed-missions + LOAD MORE in the UI; agents' hardcoded 200 and completed-missions 50 lifted. True keyset paging shipped where volume is unbounded: `/ops/audit` and `/ops/finance/transactions` (`before` cursor). Elsewhere bounded load-more is the deliberate v1 (tables are <500 rows; revisit at scale).                                                                    |
| DC-10 Analytics stub           | ✅ fixed                   | `GET /ops/analytics` (bookings/GMV by day, status funnel, dispatch acceptance, mission durations, wallet flows, region split) + real `/analytics` page (7/30/90-day windows, region filter, inline-SVG charts, no chart deps).                                                                                                                                                                                            |
| DC-11 Retention gaps           | ✅ fixed (auth/feed)       | Migration `webapp_audit_retention_cron`: pg_cron enabled + nightly purges (expired OTPs >7d, dead auth_devices >90d, live_feed_events >90d); backlog purged immediately (654 OTP rows). **Deferred:** `messages_backup`/`conversation_backups` sweep — user-facing E2EE backup retention is a product decision (Phase-2 as documented), not an ops default.                                                               |
| DC-12 16 dead tables           | ✅ dropped                 | The two `message_envelopes` cleanup DELETEs removed from booking/settlement services, then migration `webapp_audit_drop_legacy_tables` dropped all 16 (DDL recoverable from the original migrations; zero code references verified; all FKs pointed only within the legacy set).                                                                                                                                          |
| DC-13 avatars listing          | ✅ fixed                   | `avatars_public_read` policy dropped (public-URL reads unaffected; bucket listing dead). See **DC-21** for the bigger hole found next to it.                                                                                                                                                                                                                                                                              |
| DC-14 client_secret retained   | ✅ fixed                   | Settle/fail paths now null `stripe_client_secret`; one-time backfill nulled all non-pending rows.                                                                                                                                                                                                                                                                                                                         |
| DC-15 Prekey watermark         | ✅ fixed (visibility)      | `/ops/analytics` returns `signal_prekeys` (devices with <10 one-time prekeys); Analytics page shows a health tile. Alerting hook-up left to ops process.                                                                                                                                                                                                                                                                  |
| DC-16 Telemetry replay         | 🟡 API shipped             | `GET /ops/missions/:id/telemetry` (region-scoped, 5k points) + console hook. Map overlay UI deferred — mission-detail page is 1,300 lines and mid-mission-critical; overlay rides the next UI pass.                                                                                                                                                                                                                       |
| DC-17 Dead affordances         | ✅ fixed                   | Bookings search box + Service chips now filter for real; agents FILTER placeholder → real status/type chips; fake topbar ⌘K removed. `/live/wall` stays an explicitly-badged preview (unchanged, deliberate).                                                                                                                                                                                                             |
| DC-18 Index hygiene            | ✅ fixed                   | Duplicate vbg index dropped; covering indexes added on job_applications(agent_id), escrow_holds(offer_id), cpo_shift_sessions(shift_id), dispatch_room_intents(booking_id). Unused-index pruning deferred until query patterns settle (INFO-level).                                                                                                                                                                       |
| DC-19 Incident minimalism      | ✅ accepted                | By design (E2EE/org-owned). Documented; no change.                                                                                                                                                                                                                                                                                                                                                                        |
| DC-20 Broadcast console        | ✅ fixed (read)            | `GET /ops/broadcasts/recent` + Messenger page replaced with the System Broadcast log. Global composer deliberately deferred (product decision — broadcasts today are system- or mission-scoped).                                                                                                                                                                                                                          |

### DC-21 (NEW, found during remediation) — avatars bucket allows anonymous writes

`avatars_anon_insert` / `avatars_anon_update` policies allow anyone holding the app's anon key (extractable from the APK) to upload to — and **overwrite any object in** — the public avatars bucket (paths are guessable: `<userId>/avatar.<ext>`; mobile uploads with `upsert:true`). This is defacement + abuse-content risk, worse than the listing WARN. **Not fixable server-side alone:** mobile uploads directly with the anon key, so dropping the policies breaks avatar upload. Remediation path (needs a coordinated mobile release): auth-service issues signed upload URLs (service-role `createSignedUploadUrl`), mobile switches `src/services/supabase.ts` to `uploadToSignedUrl`, THEN drop both anon policies. Until then the exposure is limited to the avatars bucket (5 MB/object cap, image MIME allowlist). Tracked for the next mobile build.

### Post-remediation coverage

Live-but-dark tables went from 33 → **~6** (mission_telemetry has API-only ops access; messages/conversation backups + vault/incident content remain correctly E2EE-opaque; `channel_membership_intents`/`dispatch_room_intents` remain internal plumbing with no ops need). Dead tables 16 → **0**. RLS ERROR advisors 4 → **0**.

### Follow-up — 2026-07-07 (same day, second pass)

The two flagged-deferred items were subsequently **implemented**, and a filter bug in the shipped Users page was fixed:

- **DC-21 avatars anon write — FIXED (no longer deferred).** Deployed a Supabase Edge Function `avatar-upload-url` (service-role, `verify_jwt` off) that verifies the caller's Bravo JWT via auth-service `/auth/me` and mints a signed upload URL scoped to the caller's own `<userId>/avatar.<ext>`. Mobile `src/services/supabase.ts` now uploads via `uploadToSignedUrl` instead of the anon key. Migration `avatars_drop_anon_write_policies` dropped `avatars_anon_insert` + `avatars_anon_update`, closing the "anyone with the anon key can overwrite any avatar" hole. Security advisors now **0 ERROR / 0 WARN**. Public avatar reads unchanged. Note: the currently-installed QA build still uses the old anon-upload path, so avatar upload needs the next APK; reads and everything else are unaffected.
- **DC-04 account suspension + erasure — FIXED (no longer deferred).** Migration `users_account_suspension` adds `suspended_at/reason/by`. `auth.service` login/verify/refresh now gate on `suspended_at IS NULL` (alongside the existing `deleted_at IS NULL`), with a regression test. New ops endpoints `POST /ops/users/:id/suspend` (SUPERVISOR+, reversible, revokes all sessions), `/restore`, and `/erase` (ADMIN-only GDPR erasure: soft-delete `deleted_at` + scrub name/email/phone/avatar/bio + revoke sessions; booking/wallet history retained for audit). Surfaced on the user-detail page (suspend/restore/erase controls + suspended banner). This resolves the "no user administration / erasure path" gap (DC-04) end to end.
- **Users-page filter bug (regression in the first pass) — FIXED.** The `/users` role chip sent `role='client'` and the KYC chip `'verified'`, but the DB stores clients as `role='individual'` and verified users as `kyc_status='approved'` — so filtering "Client" returned zero rows ("showing none"). Chips now map to the real values, a **Lite/Pro tier filter** was added (backend `?tier=`), and the tier renders as a badge with `individual` shown as "Client".

---

## 1. Database inventory (what we actually have)

91 tables in `public`. Live DB is small (largest: `sealed_envelope_archive` 12 MB) — nothing is at scale risk yet, which makes this the right time to fix coverage and hygiene. Grouped by domain, with approximate live row counts:

| Domain                              | Tables (rows)                                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bookings/dispatch**               | lite_bookings (174), lite_booking_audit (322), lite_booking_add_ons (4), dispatch_offers (36), dispatch_room_intents (2), escrow_holds (13), booking_disputes (0), booking_cpo_assignments (1), jobs (58), job_applications (64)                                  |
| **Missions/field ops**              | missions (34), mission_crew (39), mission_waypoints (238), mission_principals (0), mission_payouts (10), mission_telemetry (8), mission_telemetry_last (6), sos_events (7), agent_deployment_checks (152), live_feed_events (145)                                 |
| **Agents/orgs/fleet**               | agents (38), agent_profiles (39), agent_documents (228), agent_kyc_checks (152), agent_review_pipeline (190), agent_audit (239), org_members (7), org_audit_log (19), cpo_pool (44), vehicle_pool (10), compliance_credentials (10), armed_authorizations (0)     |
| **Money**                           | wallet_balances (51), wallet_transactions (138), wallet_credit_batches (58), invoices (1), invoice_sequences (1), promo_codes (1), promo_redemptions (0)                                                                                                          |
| **Users/auth/security**             | users (127), admin_users (9), auth_devices (396), auth_otps (719), auth_totp_secrets/backup_codes (0), blocked_users (0), family_members (0), signal_identities (95), signal_one_time_prekeys (5,053)                                                             |
| **Dept-chat/attendance/incidents**  | department_channels (23), department_channel_members (44), channel_membership_intents (27), cpo_shifts (1), cpo_shift_sessions (5), cpo_shift_assignments (1), incident_reports (4), incident_events (13), incident_attachments (2), incident_attachment_keys (3) |
| **VBG (protectee app)**             | vbg_monitoring (3), vbg_telemetry_last (2), vbg_sra_snapshots (87), vbg_favorites (1), vbg_geofences (0), vbg_device_keys (4)                                                                                                                                     |
| **Messenger (E2EE, server-opaque)** | conversations (34), conversation_members (66), system_broadcasts (77), sealed_envelope_archive (1,690), messages_backup (149), conversation_backups (17), identity_backups (5), backup_merkle_commits (4), backup_session_snapshots (4)                           |
| **Ops audit**                       | ops_audit (666)                                                                                                                                                                                                                                                   |
| **Dead/legacy (see DC-12)**         | bookings, booking_addons, booking_assignments, itineraries, corporate_accounts, corporate_members, wallets, gps_pings, gps_pings_default, audit_events, message_envelopes, vault_items, media_recipient_grants, agent_coverage_zones, intel_items, intel_sources  |

Storage buckets: `bravo-messenger-media` (private, 50 MB cap) and `avatars` (**public**, 5 MB cap, listing enabled — see DC-13). Migration ledger: 84 migrations applied, coherent, latest matches shipped work (no drift).

### Coverage headline

| Bucket                                             | Tables | %   |
| -------------------------------------------------- | ------ | --- |
| Surfaced in the webapp (full or partial read path) | 34     | 37% |
| Live data with **no** webapp surface               | 33     | 36% |
| Dead/legacy tables                                 | 16     | 18% |
| E2EE stores — correctly invisible by design        | 8      | 9%  |

Industry benchmark for an ops/admin console: every operational domain the business runs on should have a read surface, every money-moving table should have a ledger view, and every admin action log should have a browser. We are at roughly half of that.

---

## 2. Coverage matrix (domain → API → webapp)

✅ = adequate • 🟡 = partial • ❌ = missing • 🔒 = E2EE, opaque by design

| Domain                                                             | API surface                                                  | Webapp surface                                                      | Verdict                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------- |
| Bookings lifecycle (lite_bookings + audit)                         | `/ops/bookings` list/detail/approve/reject/dispatch/complete | List + rich detail incl. FSM, audit trail, team, pricing            | ✅ (no paging, DC-09)            |
| Jobs & applications                                                | `/ops/jobs`, `/ops/applications/:id/*`                       | Kanban + detail + shortlist/assign/reject                           | ✅                               |
| Agents & vetting                                                   | `/ops/agents` (+docs/kyc/pipeline/decide/terminate)          | List + full operational/approval detail                             | ✅ (LIMIT 200, DC-09)            |
| Missions live ops                                                  | `/ops/missions` + deployment/routes/messages/SOS actions     | Live map, mission detail (1,326-line page), waypoints, crew, vitals | ✅                               |
| Auto-dispatch engine                                               | `/ops/dispatch/*` monitor/requests/killswitch                | Dispatch console + inspector w/ offer cascade, escrow, timeline     | ✅                               |
| Compliance credentials                                             | `/ops/compliance/pending` + verify/reject                    | Queue page                                                          | 🟡 armed permits missing (DC-03) |
| **Armed authorizations**                                           | verify endpoint only — **no list**                           | none                                                                | ❌ DC-03 (dead-ended workflow)   |
| **Disputes**                                                       | resolve endpoint only — **no list**                          | none                                                                | ❌ DC-02 (dead-ended workflow)   |
| **Wallet ledger / credits / escrow / payouts / invoices / promos** | mobile self-serve reads only; ops has blind `adjust`         | Finance page = stub                                                 | ❌ DC-01                         |
| **Users (clients)**                                                | subsets leak via booking/agent detail                        | no user list/search/detail/suspend                                  | ❌ DC-04                         |
| **SOS history (incl. mission-less panic)**                         | per-mission reads; ack/escalate/resolve                      | live mission panel only; no SOS log                                 | ❌ DC-06                         |
| **VBG monitoring/watchdog/SRA**                                    | mobile-only endpoints                                        | none                                                                | ❌ DC-07                         |
| **Audit trails (ops_audit global, agent_audit, org_audit_log)**    | per-subject last-50 only; agent/org audit write-only         | per-record timelines only                                           | ❌ DC-08                         |
| Analytics / GMV / rollups                                          | `/ops/dashboard` KPIs (point-in-time only)                   | Dashboard KPIs; Analytics page = stub                               | 🟡 DC-10                         |
| Dept-chat oversight (channels, attendance, incidents)              | `/ops/departments`, `/ops/deptchat/*`                        | channels list, attendance summary + CSV/PDF, incident status list   | ✅ (content E2EE 🔒, accepted)   |
| System broadcasts                                                  | per-subject/conversation reads + mission send                | mission OpsChat only; Messenger console = stub                      | 🟡 DC-20                         |
| Telemetry history (mission_telemetry)                              | agent-write; no ops read                                     | live position only, no replay                                       | ❌ DC-16                         |
| Signal key/device inventory                                        | client-facing key fetch only                                 | none (no prekey-exhaustion monitoring)                              | ❌ DC-15                         |
| Messenger E2EE stores (backups, sealed archive, vault)             | owner-device-only, verify-gated                              | correctly none                                                      | 🔒 ✅                            |

---

## 3. Findings

### P1 — data the business runs on is dark or exposed

**DC-01 · Finance: a complete money ledger exists in the DB with zero reporting surface.**
`wallet_transactions` (138 rows, typed tx enum, fiat linkage, Stripe ids), `wallet_credit_batches` (58, expiry-aware credit accounting), `escrow_holds` (13, full hold→settle split incl. platform fee), `mission_payouts` (10), `invoices` + `invoice_sequences` (region-numbered), `promo_codes`/`promo_redemptions`. The Finance page renders a wallet-adjust form and a literal "Finance reporting is not yet wired" placeholder. Operators move money (adjust/complete/abort-refund/dispute-resolve) **without being able to view a balance, a statement, or an escrow state first** — the adjust form takes a bare UUID. Industry standard for any platform holding client credits: per-user statement view, escrow/settlement browser, payout history, promo administration, invoice browser, reconciliation export. All of it is one `SELECT` away — the data model is already good.

**DC-02 · Disputes are a dead-ended workflow.**
Clients can raise disputes (`POST /bookings/:id/dispute` → `booking_disputes`, with a `dispute_window_seconds` product mechanic and `escrow_holds.review_required` gating release). Ops can resolve them (`POST /ops/disputes/:id/resolve`). But **no list endpoint and no console page exists** — an operator cannot discover that a dispute was filed, or learn its id, from anywhere in the webapp. Escrow held for review would strand until someone queries the DB by hand. (0 rows today, which is exactly why this must be fixed before the first real dispute.)

**DC-03 · Armed authorizations are a dead-ended workflow.**
Same pattern: submissions write `armed_authorizations`, ops has `POST /ops/armed/:id/verify`, but `GET /ops/compliance/pending` reads **only** `compliance_credentials`. There is no way to find a pending armed permit to verify it. For a firearms-adjacent compliance flow this is a regulatory exposure, not just a UX gap.

**DC-04 · No user (client) administration surface.**
127 rows in `users` — KYC status, subscription tier, Pro renewal state, home region, deleted_at — and the console can only see a client card embedded in a booking detail. No user list, search, detail, suspend/restore, KYC review, device/session revocation (396 `auth_devices` rows), or deletion tooling (`DELETE /agents/me` is a `not_implemented` stub; `users.deleted_at` never set). Industry standard — and a GDPR/DSR operational requirement — is an admin user directory with account-state controls and an erasure path.

**DC-05 · RLS disabled on 4 tables (Supabase ERROR-level advisors).**
`promo_codes`, `promo_redemptions`, `invoices`, `invoice_sequences` are in the exposed `public` schema with **no RLS**, unlike the other 86 tables (deny-by-default since migration `20260603100000` — these four were added later and missed the pattern). Via PostgREST with the anon key this permits reading invoice billing data and enumerating promo codes/credit values. Fix is one migration: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (service-role access is unaffected).

### P2 — coverage and lifecycle gaps

**DC-06 · No SOS event log; mission-less panics have no drill-down.**
SOS handling is embedded in the live-mission panel only. `sos_events` supports mission-less rows (client/VBG panic — `mission_id` nullable since `20260705134653`) and carries a full ack/escalate/resolve lifecycle, but there is no SOS history page, and a panic without a mission has no console surface to act on it from. For a protection company, the SOS log _is_ the incident-of-record system.

**DC-07 · VBG domain (6 tables) has zero operator oversight.**
`vbg_monitoring` includes a watchdog (`missed_count`, `consecutive_fails`, `escalated_at`) — escalations land in a table nobody can see. SRA snapshots (87 rows), live telemetry, geofences: all mobile-only. If VBG is a paid protectee product, ops needs at minimum an enrollment list with heartbeat health and an escalation queue.

**DC-08 · Audit trails are write-heavy, read-starved.**
`ops_audit` (666 rows, every admin action, IP-stamped) is only exposed as per-subject last-50 timelines — no global browser, no filter by actor/action/date, no export. `agent_audit` (239) and `org_audit_log` (19) are **written and never read by any endpoint in any service**. An audit log nobody can review fails its purpose (and SOC 2-style reviews expect querying/export capability). Related: the file-vault access log (user, device, IP, outcome) goes to **container stdout only**, and failed sealed-archive writes dead-letter into a Redis list with no reader.

**DC-09 · Hardcoded caps + no pagination make DB rows unreachable from the UI.**
`/ops/agents` LIMIT 200 hardcoded, completed missions LIMIT 50, bookings default limit 50, no offset/cursor **anywhere** in the ops API (the only true paginated list in the platform is mobile `/wallet/transactions`). Once history grows past the caps, older records exist in the DB but cannot be reached from the webapp at all. Industry standard: keyset pagination on every list endpoint, with the UI exposing it.

**DC-10 · Analytics is a stub while all the rollup data exists.**
Dashboard KPIs are point-in-time only; `gmv_today_aed` is fetched and never displayed; the Analytics page is a placeholder. `lite_bookings` totals, `wallet_transactions`, mission timestamps (`pickup_at`/`live_at`/`ended_at`), `dispatch_offers` response times, and `lite_booking_audit` FSM timings support standard rollups (GMV trend, conversion funnel, dispatch acceptance rate, SLA/latency) with no schema work.

**DC-11 · Retention/purge gaps (auth + backups).**
Working well: relay 30-day dwell, sealed archive 90-day sweep, media 30-day grants + orphan GC, push tokens 90d. Gaps: `auth_otps` retains 718/719 **expired** OTP rows (no purge job); `auth_devices` keeps 382 revoked/expired rows; `live_feed_events` unbounded since April; `messages_backup`/`conversation_backups` have **no retention sweep** (documented as Phase-2, currently only a 500k-row per-user cap) — durable ciphertext accumulating indefinitely conflicts with the transient-relay posture and deserves a stated policy.

**DC-12 · 16 dead/legacy tables (18% of schema).**
Two parallel _money_ schemas (`wallets` vs `wallet_balances`) and two parallel _booking_ schemas (`bookings`+`booking_addons`+`booking_assignments`+`itineraries`+`corporate_*` vs `lite_bookings`) coexist; plus `gps_pings`/`gps_pings_default` (superseded by mission_telemetry), `audit_events` (superseded by ops_audit), `message_envelopes` (superseded by Redis relay + sealed archive), `vault_items` and `media_recipient_grants` (superseded by R2-key + Redis-grant flows), `agent_coverage_zones`, `intel_items`/`intel_sources` (no service references them). All 0-row except intel (1–3 seed rows). Dead tables are where the next engineer writes the wrong query. Archive the DDL and drop them.

**DC-13 · `avatars` bucket is public with listing enabled (Supabase WARN).**
A broad SELECT policy on `storage.objects` lets clients enumerate every avatar object. Public-read of individual objects may be intended; listing the whole bucket is not.

### P3 — hygiene and hardening

**DC-14** · `wallet_transactions.stripe_client_secret` is persisted and retained after settlement. Client secrets are one-time bootstrap material; null them on settle.
**DC-15** · No Signal key/device inventory: 5,053 one-time prekeys with no low-watermark monitoring (standard practice for Signal-protocol servers to prevent silent X3DH fallback), no per-user device/key admin view.
**DC-16** · `mission_telemetry` history has no ops read — no route replay for post-incident reconstruction, a normal capability in protection ops platforms.
**DC-17** · Non-functional UI affordances promise data access that doesn't exist: bookings search box, bookings Service filter chips, agents FILTER button, topbar ⌘K — all dead; `/live/wall` renders hardcoded sample data. Ship or remove.
**DC-18** · DB micro-hygiene (advisor INFO/WARN): duplicate index on `vbg_monitoring` (drop one), ~35 unindexed FKs (add covering indexes on the hot ones: `job_applications`, `cpo_shift_sessions`, `escrow_holds`), a long tail of never-used indexes to prune once query patterns settle.
**DC-19** · Incident oversight shows status/severity only — narratives, coordinates, and evidence are org-owned/E2EE. **Correct by design**; record it as an accepted limitation so it isn't re-reported.
**DC-20** · `system_broadcasts` (77 rows) has per-subject/per-conversation read APIs, but the Messenger console page is a stub — no broadcast composer or delivery log beyond mission chat.

---

## 4. Industry-standard benchmark checklist

How the webapp measures against a standard ops/admin console for a marketplace/fintech-adjacent platform:

| Capability                                    | Standard                         | Bravo today                                    |
| --------------------------------------------- | -------------------------------- | ---------------------------------------------- |
| Every operational domain readable             | ✅ expected                      | ❌ finance, disputes, VBG, SOS log, users dark |
| Money-movement preceded by ledger visibility  | ✅ expected                      | ❌ blind adjust by UUID                        |
| Global, filterable, exportable audit log      | ✅ expected (SOC 2)              | ❌ per-record timelines only                   |
| Server pagination on all lists                | ✅ expected                      | ❌ none (hardcoded caps)                       |
| Global search across entities                 | ✅ expected                      | ❌ (⌘K is a placeholder)                       |
| CSV/report export                             | ✅ expected                      | 🟡 attendance only                             |
| User administration + DSR/erasure path        | ✅ expected (GDPR)               | ❌ missing; delete stubbed                     |
| Data-retention policy enforced by jobs        | ✅ expected                      | 🟡 strong on messenger, absent on auth/backups |
| RLS/least-privilege on exposed schema         | ✅ expected                      | 🟡 86/91 tables (4 ERROR-level holes)          |
| No dead schema in production                  | ✅ expected                      | ❌ 16 legacy tables                            |
| E2EE boundary: server/ops cannot read content | ✅ (this product's core promise) | ✅ **correctly enforced end-to-end**           |

---

## 5. Recommended roadmap (priority order)

1. **One migration, same day (DC-05, DC-13, DC-18):** enable RLS on the 4 exposed tables; drop the avatars listing policy; drop the duplicate vbg index.
2. **Unblock the dead-ended workflows (DC-02, DC-03):** add `GET /ops/disputes?status=` and fold pending `armed_authorizations` into `/ops/compliance/pending` (or a sibling list); surface both in the existing Compliance/Inspector pages. Small, uses existing patterns.
3. **Finance read surface (DC-01):** `/ops/finance/*` read endpoints (transactions w/ keyset paging, escrow list, payout history, invoice list, promo list) + replace the Finance stub with ledger views and CSV export. Reuse the attendance-export pattern for CSV and the inspector table pattern for UI.
4. **User directory (DC-04):** `/ops/users` list/search/detail + suspend + device revocation; wire `users.deleted_at` into a real erasure runbook.
5. **SOS log + VBG oversight page (DC-06, DC-07):** one SOS history table (all events, mission-linked or not) and one VBG enrollment/health table with the escalation queue.
6. **Global audit browser (DC-08):** `/ops/audit` with actor/action/date filters + export; add readers for `agent_audit`/`org_audit_log`; persist the vault access log to a table.
7. **Pagination pass (DC-09):** keyset pagination on ops list endpoints, UI load-more; lift the agents LIMIT 200 and completed-missions LIMIT 50.
8. **Retention jobs (DC-11):** cron purge for expired `auth_otps`/dead `auth_devices`, cap `live_feed_events`, decide + implement the Phase-2 backup retention sweep.
9. **Drop the 16 legacy tables (DC-12)** after archiving DDL; then Analytics rollups (DC-10), broadcast console (DC-20), telemetry replay (DC-16), prekey watermark alert (DC-15), and remove or implement the dead UI affordances (DC-17).

---

## Appendix A — evidence

- **Schema/rows:** `information_schema.columns` + `pg_stat_user_tables` (91 tables; counts above). Largest relation `sealed_envelope_archive` = 12 MB.
- **Advisors (security):** 4× ERROR `rls_disabled_in_public` (promo_codes, promo_redemptions, invoices, invoice_sequences); 1× WARN `public_bucket_allows_listing` (avatars); 86× INFO `rls_enabled_no_policy` (expected: deny-by-default with service-role access).
- **Advisors (performance):** 1× WARN duplicate index (`vbg_monitoring`); ~35× INFO unindexed FKs; ~40× INFO unused indexes.
- **Hygiene queries:** expired OTPs retained = 718; revoked/expired auth_devices = 382; expired-but-unswept sealed envelopes = 0 (sweep working); overdue-unexpired credit batches = 0 (expiry job working); live_feed_events oldest = 2026-04-24.
- **Migrations:** 84 applied, monotonic, latest = `20260706072645_ops_gated_auto_dispatch` (matches shipped work — no drift).
- **API map:** auth-service exposes ~50 `/ops/*` routes (guard chain JWT→CSRF→AdminGuard, SUPERVISOR/ADMIN on mutations, region scoping via `assertRegionScope`, ADMIN = global). messenger-service has **no** admin/ops routes by design; ops-console talks to it purely as an E2EE client.
- **Console map:** 23 pages; stubs = /analytics, /messenger, /finance (reporting half), /live/wall (sample data). CSV/PDF export exists only on /dept-attendance. Real-time = SWR polling (2s/5s), no socket for ops data grids.

## Appendix B — E2EE boundary (verified correct, do not "fix")

`messages_backup`, `conversation_backups`, `identity_backups`, `backup_merkle_commits`, `backup_session_snapshots`, `sealed_envelope_archive`, vault objects, department-channel content, and mission group chat are ciphertext to the server and reachable only by the owning user's authenticated device (verify-token/MFA-gated). The webapp correctly decrypts its own messenger runtime client-side and never gets a server-side plaintext view of anyone else's content. Any future "ops should read messages" request is an architecture-doc stop-condition, not a coverage gap.
