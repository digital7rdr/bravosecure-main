# Dead-Phone Smoothness Plan — a messenger that feels light on the weakest Android

**Date:** 2026-08-28 · **Branch:** `main` @ `eee66aa6`
**Goal (founder):** a lightweight messenger that runs smoothly even on a "dead" phone —
think 2 GB RAM, an old SoC, slow eMMC storage, 16–32 GB of which most is full.
**Method:** two-agent adversarial audit — a primary auditor and a context-sharing partner
who audited independent lanes (boot path, per-send IO, memory) and then attacked the
primary's theses in a rebuttal round. Positions that lost the debate are recorded in §6,
because knowing what was refuted is half the value.
**Evidence quality:** no device was attached this session. The APK numbers are measured
from the actual shipped artifact (hard evidence); the millisecond figures are V8
microbenchmark floors or prior on-device measurements from B-279/B-632 — Hermes is
several times slower than V8. Line numbers go stale fast in this repo: **re-grep the
symbol, never trust a stamped line.**

---

## 0. The one-paragraph answer

The app's JS-thread discipline has been fixed hard, case by case (B-155, B-279/280,
B-632..634, the 2026-08-24 lag audit) — and the remaining smoothness gap on a weak phone
is NOT more of that. It is four structural things nobody has priced until now:
**(1)** the release artifact is **604 MB** — ten times WhatsApp — because it ships four
CPU architectures, two complete call engines, and an unminified 28 MB DEX;
**(2)** five seconds after every burst of chatting, the backup layer **re-downloads and
re-hashes the user's entire encrypted history** to compute a Merkle root, when a fast
path that hashes only the changed rows already exists in the code and is simply never
fed; **(3)** every cryptographic hash and every wire text-encode/decode in the app runs
in **interpreted JavaScript**, because a boot polyfill deletes the native implementations
to work around two library bugs; **(4)** there is no device-time budget harness, so perf
regressions keep shipping through green suites — the last lag wave was caused by a
commit _named_ "perf spine".

---

## 1. What we already know — do not re-derive

The lag history in CLAUDE.md ("The app feels laggy" section) is the contract. In short:

- The freeze class is **JS-thread-bound**, proven twice (jsThreadWatchdog + Android's
  own `Looper PerfMonitor`, single queue messages up to 6.2 s). The GPU is idle
  (3–7 ms against a 16.7 ms budget) — **never** "fix lag" by deleting shadows,
  gradients or blur.
- **Measured dead ends** (do not re-propose without new numbers): shadows/gradients,
  ChatScreen hooks, message bubbles, the composer, closed-modal gating, FlatList
  window tuning, `runAfterInteractions` deferral (2× WORSE), media encrypt probes,
  1:1 Signal send stages (instrumented at >120 ms — produced **no lines** during the
  founder's freezes).
- The structural per-mutation costs are gone (B-632 `markDirty` scans, B-633
  stringify-per-set, B-634 double-mirror). None of it device-confirmed; the
  `[LAGDIAG]` probes have been in the tree since 2026-07-27 and have **never been read
  off a phone**.
- JS hydration is properly bounded: `loadRecent` caps 200 rows/conversation **in SQL**
  (`sqlMessageStore.ts`, ROW_NUMBER + `idx_messages_conv_created`), boot hydration is
  one `set()` (`bootstrapDrainYield`). The memory unknown is **native**, not JS (§3, F7).

---

## 2. The findings

### F1 — the release APK is 604 MB; ~70 % is architectures no user has · B-685

Measured from `android/app/build/outputs/apk/release/app-release.apk` (2026-08-28):

| slice           | size       | note                                                                     |
| --------------- | ---------- | ------------------------------------------------------------------------ |
| lib/arm64-v8a   | 150 MB     | the only ABI real users need                                             |
| lib/x86_64      | 132 MB     | BlueStacks QA only                                                       |
| lib/x86         | 132 MB     | BlueStacks QA only                                                       |
| lib/armeabi-v7a | 108 MB     | legacy 32-bit; near-zero real base                                       |
| classes.dex     | 28 MB      | R8/minify **off** (`build.gradle:82` default-false), shrinkResources off |
| assets + res    | 20 MB      | JS bundle, fonts, images                                                 |
| **total**       | **604 MB** | WhatsApp's entire APK is ~60 MB                                          |

Inside **each** ABI: Agora ~60 MB (core 26.8 + lip-sync 6.6 + clear-vision 5.4 +
spatial-audio 4.4 + 2× AI-noise-suppression + ffmpeg 5.6), Mapbox ~19 MB, WebRTC
(`libjingle_peerconnection`) 11 MB, ML Kit face detector 8 MB.

Dead weight confirmed by grep: `react-native-mmkv` and `react-native-worklets-core`
have **zero imports in `src/`**; `expo-av` ships alongside its replacements
`expo-audio` + `expo-video`.

**Why this is a smoothness finding, not just an install nicety** (settled in the
debate): (a) first-order and binary — on a 16–32 GB phone, 604 MB is frequently
_uninstallable_, and an app that cannot install has infinite latency; (b) second-order
but real — a near-full eMMC measurably degrades write latency, which sits directly
under every SQLCipher write (the agreed unmeasured lane, F8), and 28 MB of unminified
DEX adds dexopt and class-load cost to every cold start.

### F2 — a second, non-functional call engine ships in every build · B-686

`react-native-agora` is ~60 MB per ABI of native code whose feature **cannot work
end-to-end**: the token endpoint is "NOT YET IMPLEMENTED on the server"
(`agoraStart.ts:7-9`) and the fallback "was never wired to a real Agora SDK boot"
(`useCall.ts:243`). The JS side is lazily required, so the only thing the dependency
does today is inflate the artifact. **Decision box §5-D1** — removal is a product
decision (the founder may believe a call fallback exists).

### F3 — the steady-state Merkle commit re-downloads and re-hashes the ENTIRE history after every chat burst · B-687

The after-flush hook (`mirrorBootstrap.ts` → `commitMerkleRootNow`) calls
`commitMerkleRoot` with **no leaves and no rows**, which takes the full-walk branch:
page-cursor download of the user's whole encrypted backup from the server
(`merkleCommit.ts`, up to 1000×1000 rows), then base64-decode + pure-JS sha256 of
every row (`backupMerkle.ts`). The old "every 30 s" cadence (2026-07-02 audit) is
gone — it is now debounced **5 s after each flush burst** (`messageMirror.ts:62`),
i.e. _more_ frequent while actively chatting. The code's own comment records **9.5 s
of hashing at just 1,372 rows**, co-timed with 4.7 s LAGDIAG stalls. B-310 made it
yield (it no longer blocks in one chunk), but the CPU, radio, and battery cost still
scales with the entire history, per send burst, forever.

The fix path already exists: the **M-12 `leaves` fast path** in `commitMerkleRoot`
accepts precomputed leaves — the hook just never feeds it.
`docs/planning/BACKUP_BOUNDARY_BATCHING_PLAN.md` already points here.
**Stop-condition note:** the write side only. `verifyMerkleCommit` and the verifier's
synchronous `computeMerkleRoot` are ARCH-GATED and stay untouched (BACKUP_LOOP I3).

### F4 — every hash and every wire text codec runs in interpreted JavaScript · B-688

`index.js` loads `src/modules/messenger/crypto/polyfills.ts` before anything else,
and it does two things nobody had priced:

1. **Deletes Hermes's native `TextEncoder`/`TextDecoder`** and replaces them app-wide
   with the pure-JS `text-encoding` package (needed only because jose/op-sqlite want
   utf-16le, which Hermes lacks).
2. **Routes all `subtle.digest` SHA-1/256/384/512 through pure-JS `@noble/hashes`**,
   because `react-native-quick-crypto@0.7`'s native EVP digest lookup is broken
   ("Invalid Hash Algorithm!").

Verified placement (debate round 2): the codec is **not** on the per-DB-read path —
SQLCipher rows cross JSI as JS strings and `rowToMessage` uses Hermes-native
`JSON.parse`. The hot consumers are per-message and per-walk: sealed-sender
encode/decode on every send and receive (`outerEcies.ts`), every group message
(`groupCrypto.ts`), sender certs, every Merkle leaf (`backupMerkle.ts`), every
mirrored row (`messageMirror.ts`). So this is a **send/receive/restore multiplier**,
not an app-wide UI tax. One honest floor note: the whole Signal stack here
(`@privacyresearch/*`) is pure TypeScript — curve25519 scalar mults included —
interpreted by Hermes with no JIT. Native libsignal is the long-term ceiling of this
lane; not proposed now.

### F5 — the boot path pays for every product, for every user

- `MainNavigator.tsx` statically imports **all role navigators**; the Agent chain
  module-evaluates `@rnmapbox/maps` at JS boot for every account, including
  pure-messenger users (left OPEN by the 2026-08-24 audit; still true).
- `App.tsx` returns `null` until **six** Manrope font weights load, and mounts
  `StripeProvider` (native Stripe SDK) at the root of a messenger.
- No Baseline Profile exists anywhere in `android/` (ART JIT-interprets the hot
  startup path on first runs — the runs a new user judges the app by).
- Nobody has ever taken a Perfetto/systrace cold-boot trace on any device.

### F6 — perf regressions ship because the gates pin mechanisms, not budgets

Real pins exist (`chatListMountBudget`, `messengerRenderPerf`, `bootstrapDrainYield`,
`storePerSetCost`, `backupLagProbes`, `size-limit`) — the debate corrected the claim
that there is "no gate". What is true: they are all _mechanism_ pins. Nothing measures
**time on a device**, and nothing catches the M8 class — a new store subscription
appearing in an always-mounted subtree — which is exactly how the 2026-08-24 "perf
spine" regression shipped through a green suite.

### F7 — low-RAM behavior has never been measured

No `dumpsys meminfo` baseline exists on any device. JS-side hydration is bounded
(§1), so the 2 GB risk is **native** resident memory — WebRTC + Mapbox eval +
Firebase + Stripe all warm at boot. Android Go's low-memory killer will evict us long
before an OOM crash would ever appear in Crashlytics; to the user that reads as "the
app forgets everything every time I switch away" — a smoothness bug by another name.

### F8 — the per-send disk write is still uninstrumented

The SQLCipher write path and `[backup.merkle]` cadence were never measured on a
device (B-632 closure says so explicitly). On slow eMMC this is the likely residual
per-send cost once F3 is dead. Note only, ARCH-GATED: `PRAGMA
cipher_memory_security=ON` (`crypto/db.ts`) taxes every DB operation by design;
changing it requires architecture approval and is **not** proposed here.

---

## 3. Budgets — what "smooth on a dead phone" means in numbers

**Reference devices:** keep the Redmi Note 11 as the mid-tier floor (all prior
measurements live on it) and acquire **one true low-end 2 GB Android Go device**
(Redmi 9A / Galaxy A03 Core class) — §5-D3.

| budget                               | target                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Cold start → first interactive frame | < 2.5 s on the Go device ("interactive" = first nav frame answers a touch)                        |
| Cold start → chat list painted       | < 4 s on the Go device                                                                            |
| Chat open (tap → thread visible)     | < 300 ms target (expect ~400 ms initially: B-279's 61–105 ms on the Redmi × a 3–5× Go multiplier) |
| Send tap → own bubble rendered       | < 100 ms                                                                                          |
| 10-fast-sends burst                  | no JS-thread stall > 250 ms (watchdog drift)                                                      |
| Idle watchdog drift, 99th percentile | < 120 ms                                                                                          |
| Steady memory (PSS) on the Go device | < 350 MB (in-call tracked separately; +~100 MB WebRTC is legitimate)                              |
| **Background bytes per 100 sends**   | near-zero after F3 (TrafficStats probe — pins the Merkle win permanently)                         |

**Artifact-size ladder** (a single "<100 MB now" was refuted in the debate — arm64
libs alone are 150 MB):

| rung                                           | user-facing size | needs                        |
| ---------------------------------------------- | ---------------- | ---------------------------- |
| today (universal 4-ABI)                        | 604 MB           | —                            |
| arm64-only artifact                            | ~230 MB          | build config only, zero risk |
| + R8 + shrinkResources                         | ~200 MB          | one QA regression pass       |
| + Agora removed                                | ~140 MB          | founder decision D1          |
| + Mapbox/ML-Kit/expo-av resolved + asset audit | < 100 MB         | per-dependency decisions     |

---

## 4. The roadmap — five workstreams, in the order the debate settled

> **W1 STATUS: BUILT 2026-08-28 (same day), critic-reviewed AGREE — device smoke OWED.**
> Measured: universal QA APK 604 → 327 MB; **arm64 user APK 604 → 109.6 MB (−82 %)**
> — beating this plan's own ~140 MB ladder rung because Agora's real per-ABI weight
> (~79 MB) exceeded the estimate. dex 28.2 → 14.7 MB. Agora removed (D1 executed:
> critic verified `opts.agoraStart` was never read, ICE-failure behavior identical);
> mmkv + worklets-core removed; **expo-av KEPT — still live** (VoiceNoteRecorder,
> PermissionsScreen, bravoTones). New `npm run apk:user` → `scripts/build-user-apk.ps1`.
> `res/raw/keep.xml` pins the JS-string-referenced resources. Full record: sqa.md
> B-685/B-686 fix entry. Two W3-harness notes from the review: R8's `usage.txt`
> falsely reports kept classes as removed — triage from `mapping.txt` + the dex, never
> usage.txt; and `cross-env-shell` under cross-env v10 no-ops silently (B-689 —
> `apk:dist` uses the same pattern and is suspect).

**W1 — Ship users a phone-sized artifact (F1, F2).**
Per-ABI delivery: users get arm64 (AAB or split APK); QA keeps a universal/x86_64
build for BlueStacks. Do **not** delete x86 from `reactNativeArchitectures` —
BlueStacks QA needs it, and QA evidence should not run through ARM translation. Turn
on R8 + shrinkResources (one flag each, one full QA pass — Hermes bytecode is
unaffected; this is DEX and resources). Uninstall `react-native-mmkv`,
`react-native-worklets-core`, and `expo-av` if the audio/video migration is complete.
Agora rides on decision D1. _Biggest win per unit risk in the whole program; no code
changes._

> **W2 STATUS: COMPLETE — FLIP LIVE 2026-08-29, device-proven.** Founder
> approved flipping without the calendar soak; the design converts the soak
> into a permanent per-session audit (first ambient commit walks + verifies the
> cache, later commits cache-sign). Device: walk 8.7 s → `match=true
1466/1466` → `cache-signed` at **818/911 ms** covering mid-burst growth —
> 10–40× per checkpoint, zero walk bytes. Contract now lives in BACKUP_LOOP
> §1b. Original shadow record below for provenance.
>
> **W2 STATUS (superseded): SHADOW MODE BUILT 2026-08-28 (same day).** Commit behavior is
> byte-unchanged (test-pinned); a persistent leaf cache (`merkleLeafCache.ts`,
> schema v22) is captured at flush time and compared against every walk, logging
> `[backup.merkle.shadow] match=…`. The partner audit's make-or-break finding is
> baked in: the client's `toISOString()` timestamp does NOT round-trip through
> Postgres `to_json` — `pgTimestamptzText` reproduces the server form, and a
> naive cache would have manufactured `root_mismatch` on every row. Deletion
> tombstones are server UPSERTS (rows remain), which also carries the founder's
> "deleted chats must not come back after restore" requirement through this
> change untouched. **The FLIP (commit from cache, no walk) is a separate
> future commit** gated on: device soak with zero epoch-clean divergences
> (sends, tombstones, a repair, a restore round-trip), fallback-to-walk on
> dirty/empty cache, boot-heal + repair staying walk-based forever, a
> seeded-marker. Mechanism + probe guidance: BACKUP_LOOP.md §1b and §5.1-4.
>
> **DEVICE EVIDENCE (2026-08-28 night, founder's Redmi Note 11):** the steady-state
> disease measured live — after send bursts, **14 walk-commits drained back-to-back at
> 8.8–33.8 s each (median ~13 s, rows≈1350)**, ~4.5 min of continuous re-download +
> re-hash, several for ZERO new rows. Also exposed **B-690** (fixed same night): the
> walk's body read was unbounded, so one mid-body connection reset left `res.json()`
> hanging silently and wedged the single-flight commit chain for ~6 minutes until the
> OS socket died. Full record: sqa.md B-690 entry.

**W2 — Stop re-hashing the world: incremental Merkle commits (F3).**
Feed the existing M-12 `leaves` path from the local mirror/ledger instead of
re-downloading the entire history. Write-side only; the verifier stays byte-for-byte
untouched (BACKUP_LOOP I3 — this is the runbook's territory, run its §2 invariants
and §4 gates). Success is measured by the bytes-per-100-sends budget going to
near-zero. _Kills the largest recurring background cost, the radio burn, and the
biggest consumer of pure-JS hashing in one move._

> **W3 STATUS: BUILT 2026-08-29.** (a) `scripts/perf-journey.ps1` — scripted
> (swipes/BACK only, never taps) or passive journey against any ADB device;
> parses stalls/send.total/walks/shadow/gfxinfo/PSS and writes a budget-table
> report to `docs/qa/perf-runs/`. First run recorded (PERF_20260829-0022):
> cold start 1544/1415 ms PASS (the earlier 3.7 s reading was one-time
> post-install dexopt), idle-scroll stalls worst 231 ms PASS, PSS 221 MB PASS,
> second shadow `match=true` (soak 2-for-2). (b) `subscriptionCensus.test.ts`
> — per-file `useMessengerStore(` ledger (85 sites/23 files, comment-stripped)
>
> - the 9 whole-map subscriptions FROZEN shrink-only; mutation-proven (a
>   planted whole-map subscription reds both pins). (c) `[crypto.floor]` one-shot
>   probe in jsThreadWatchdog (real subtle.digest + codec paths, 30 s post-boot)
>   — W5's gate instrument; first number lands with the next installed build.
>   STILL IN W3: send.total sub-stage probes (MESSAGE_LOOP session required —
>   productionRuntime is its territory) and a Perfetto trace (with W4).

**W3 — The reference-device budget harness (F6) — what makes every other win stick.**
(a) A scripted adb journey (cold start → open chat → 10 fast sends → tab switch →
back) on a release build, reading `jsThreadWatchdog` drift + `[LAGDIAG]` markers off
the device and recording them per build — the probes have waited 13 months to be
read. Interleave A/B runs (OLD/NEW/OLD/NEW — thermal drift lies otherwise).
(b) A subscription-census source scan in the existing pin idiom: per-file allowlisted
counts of `useMessengerStore(` on always-mounted surfaces (App root,
MessengerHomeScreen, tab bars, FloatingCallOverlay, BravoAlertHost) + a ban on
whole-map subscriptions outside a named allowlist. Raising a count requires editing
the allowlist next to a comment — the M1/M8 class caught at diff time. CRLF-aware,
comment-stripped, ~1 day.
Add `[LAGDIAG]` probes around SQLCipher writes, `[backup.merkle]`, and the curve ops
specifically — the W5 scope decision needs to know whether digest or curve dominates.

> **W4 STATUS: BUILT + DEVICE-SEALED 2026-08-29.** The real Mapbox boot cost was
> **androidx.startup** (native, process-create, ~4s BEFORE first JS — device
> timeline proves it), not the JS import chain: fixed with manifest
> `tools:node="remove"` on both initializers (⚠ maps FQCN is
> `com.mapbox.maps.loader.MapboxMapsInitializer` — verify names in the MERGED
> manifest, never the logcat tag). Boot logcat now shows **0 Mapbox lines** on a
> messenger account. Also: agent/CPO shells lazy-required in MainNavigator;
> StripeProvider off the root via `withPaymentBoundary` (4 screens). Pins:
> `bootDietGuards.test.ts` (9, mutation-proven). Critic AGREE after 1 P1
> (wallet test rendered the wrapped export — jest mock added). Cold start
> 1479 ms, PSS 239 MB post-W4. OWED: agency/CPO tracker open (on-demand map
> init unexercised); Baseline Profile deferred (needs a macrobenchmark module).
> Crypto floor measured for W5: **sha256 ≈1.45 ms/KB, codec 100KB ≈260 ms** on
> the reference device — pure-JS, per B-688.

**W4 — Boot diet (F5).**
Role-gate the navigator imports (lazy `require` for the Agent/CPO/Mapbox chain so a
messenger-only user never evaluates a map engine), move `StripeProvider` off the root
to the payment flows, and take ONE Perfetto cold-boot trace on the Go device so the
rest of this lane is ranked by data instead of vibes. Evaluate a Baseline Profile
once the trace exists. The six-font-weights block stays low priority (tens of ms,
behind the splash) — listed so nobody re-audits it.

> **W5 STATUS: BUILT + DEVICE-PROVEN 2026-08-29 (D2 granted by founder).**
> Implementation-only, per the constraint: (a) digest — per-algorithm FIPS-vector
> boot probe of quick-crypto's Node-style `createHash` (`_selectHashers`),
> @noble fallback per algorithm; **device: native=4/4** — B-45's breakage was
> only ever the subtle EVP lookup. (b) codec — hybrid TextEncoder/TextDecoder:
> Hermes native for bare utf-8, text-encoding polyfill for utf-16le/options
> (`outerEcies` fatal-decode included). **Floor, same probe/phone: sha256
> 290→42 ms (6.9×), codec 100KB 280→117 ms (2.4×).** Critic AGREE (3 P2s
> landed). Residual W5 ceiling (native libsignal curves) stays future-gated.

**W5 — Restore the native crypto floor (F4) — gated on W3's numbers.**
Fix or upgrade `react-native-quick-crypto` so `subtle.digest` is native again, and
give utf-8 (the 99 % case) the native codec back, keeping the pure-JS polyfill only
for the utf-16le consumers. Same algorithms, implementation-only — but it touches the
scariest plumbing in the app, so: **arch-review request prepared in parallel now**
(approval has lead time), implementation starts only after W3's device measurement
says how much it buys. The debate's deciding card: even after W2, a **fresh-install
restore** must re-hash every row of a large account in pure JS — on a Go device, in
the user's first minutes on a new phone. That path keeps W5 on the roadmap
unconditionally; the measurement only decides its priority.

**Sequencing:** W1 ∥ W3 immediately (independent, no shared files). W2 next (plan doc
exists). W4 after W3's trace. W5 last, gated as above.

---

## 5. Decision boxes — founder input needed

- **D1 — Remove Agora from the build?** Evidence: no server token endpoint
  (`agoraStart.ts:7-9`), never wired to a real SDK boot (`useCall.ts:243`), ~60 MB
  per ABI. Recommendation: remove the package, keep the JS seam (`agoraStart.ts`) so
  it can return behind a config flag if the fallback is ever built. If a working
  Agora fallback is on the product roadmap, say so and W1 ships without this rung.
- **D2 — Approve preparing the arch-review for W5** (native digest + native utf-8
  codec; algorithms unchanged). Preparation only — no code until measurement.
- **D3 — Buy one 2 GB Android Go test device** (Redmi 9A class, ~$60–80). Every
  budget in §3 is defined against it; without it the plan has no exit criteria.

---

## 6. The debate record — claims that died, so they stay dead

| claim (holder)                                       | verdict                                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| "Build-level wins are the biggest lever" (primary)   | AMENDED — real, but the crypto floor + Merkle full-walk outrank pure size for _runtime_ feel                                     |
| "Size ≠ smoothness" (partner)                        | REVERSED — uninstallable = infinite latency; storage pressure sits under every SQLCipher write                                   |
| "No perf gate exists" (primary)                      | REFUTED — five mechanism pins + size-limit exist; the gap is device-TIME budgets + the M8 subscription class                     |
| "Crypto floor ships first" (partner)                 | RE-SEQUENCED — its 9.5 s headline was the Merkle full-walk in disguise; W2 first, measure, then W5 (restore path keeps W5 alive) |
| "APK < 100 MB now" (primary)                         | REFUTED — arm64 libs alone are 150 MB; replaced by the §3 ladder                                                                 |
| "30 s Merkle re-download" (2026-07-02 memory)        | STALE — now 5 s-debounced after every flush burst, i.e. _worse_ under active use                                                 |
| Pure-JS TextDecoder taxes every DB read (hypothesis) | REFUTED by grep — wire/crypto edges only; rows cross JSI as strings, `JSON.parse` is native                                      |

## 7. What this plan refuses to do

Strip visual design (GPU is measured-idle — B-279), re-propose any measured dead end
(§1), weaken `verifyMerkleCommit` / the verifier's synchronous `computeMerkleRoot` /
`cipher_memory_security` or any other ARCH-GATED control, or claim any fix works
before its number is read off a real device (founder rule: device-verify before
handover).

## 8. Exit criteria

Every §3 budget green on the Go device, recorded by the W3 harness on a release
build, on two consecutive builds. Until then this plan is open.
