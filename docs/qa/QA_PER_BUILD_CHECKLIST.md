# Bravo Secure — Per-Build QA Checklist

**Use:** run top-to-bottom for every new build. Tick each box. Record deltas vs the previous build.
**Devices:** BlueStacks 5555=itsirajul (`08782d6d`) · 5565=shirajul (`79d63649`) · 5575=fahim (`fe4ddc14`) · Physical: Pixel 7a / Xiaomi / Redmi (USB or Wi-Fi).
**Golden rule:** _prove the fix is in the build, and the server was deployed, BEFORE testing either._

---

## 0. PRE-FLIGHT — do NOT skip (this is where whole sessions get wasted)

- [ ] **Build identity recorded:** `versionName` + `versionCode` + **commit SHA** + branch. If the APK can't be tied to a _pushed_ commit → log "build provenance unknown" and treat all results as provisional.
- [ ] **Fix-present check:** for every bug claimed fixed since last build, confirm the fix code path is actually in the APK (grep the bundle for the new log strings / version marker). Catches "APK ahead of / behind repo" (B-13 / B-18).
- [ ] **All devices on the SAME vc** — no mixed-version session (per-vc behavior differs).
- [ ] **Server health (gates B-05):** hit `relay.94-136-184-52.sslip.io/healthz` → server up? **redeployed since last session?** uptime/version noted. Don't re-test B-05 against a server that was never redeployed.
- [ ] **ADB connected:** `adb devices` shows all intended devices.
- [ ] **Log capture armed:** live logcat streaming to per-device files BEFORE testing (auto-delete gotcha: copy/inline evidence into `sqa.md`, don't leave it only on Desktop).
- [ ] **Clean state decision:** note whether testing fresh install, in-place update, or restore — each exercises different paths.

---

## 1. BOOT HEALTH (per device)

- [ ] **Failure-signature grep — all must be 0:** `outer sealed authentication failed`, `handled=false`, `dropped undecryptable`, `case=RESTORE`, `localKey=false`, `superseded`, `io server disconnect`, keychain read-fail.
- [ ] Each device reads `localKey=true` → `case=RESUME` (not the spurious RESTORE that drove B-15b).
- [ ] No supersession churn (B-11) — multi-device online holds.
- [ ] App boots to the correct screen for the role (Individual / Corporate / Agent).
- [ ] Permissions gate behaves (camera/location/contacts/notifications).

---

## 2. MESSAGING — 1:1 (Signal encrypted)

- [ ] 1:1 text **both directions** renders in-thread + correct chat-list preview (not "(encrypted)").
- [ ] **First message on a freshly re-established pair** delivers (B-15b: first inbound on a new session may silently drop then self-heal — watch for it).
- [ ] Inbound logs `[recv.text.routing] → [recv.text.append] → [recv.text.append.after]` AND a bubble actually renders (read the screen, not just `handled=true`).
- [ ] Ordering correct; no duplicate "(encrypted)" home-list row (B-18 1:1 migration).
- [ ] Media message (image/file): encrypts, uploads, downloads, decrypts, renders both ends.
- [ ] Disappearing messages: timer deletes locally **and** server purge instruction sent.
- [ ] Read receipts / typing indicators / online dots update (and carry no message content).

## 3. MESSAGING — Group (sealed-sender broadcast)

> ⚠️ Group inbound is **log-silent** (`[recv.enter] → handled=true` only). PLAIN / RAW-JSON (B-22) / BLANK no_key (B-18) all log identically. **Verify render from the screen (uiautomator), never from logs.**

- [ ] Group text on a **real synced group where all members hold the key** → renders plain on all devices (the PASS baseline).
- [ ] Group text to a receiver who **LACKS the master key** → check for B-18 (no*key stash; should now show *"Waiting for this group's encryption key…"\_ banner, vc78+) and B-22 (raw-JSON envelope rendered instead of body).
- [ ] **Key arrives mid-session:** confirm whether stashed messages auto-drain to UI **live** (residual gap — vc78 needs app restart). Log if restart is still required.
- [ ] Group membership change (add/remove member) → rekey on removal, no plaintext leak, others still decrypt.
- [ ] No ghost "Call" groups appearing in the groups list (B-04).

---

## 4. CALLS — the densest bug cluster (test on PHYSICAL device where noted)

### 4a. 1:1 calls

- [ ] 1:1 voice: connects, DTLS-verifies (`dtls-verify-ok`), audio both ways.
- [ ] 1:1 video: connects, remote full-screen + self PiP both ends (note: BlueStacks shared-camera shows same-face — use physical to confirm real frames).
- [ ] 1:1 audio→video **upgrade** renegotiates + renders both ends (B-16 — was PASS on vc78).
- [ ] Clean hang-up (End Call) → `finalState: ended` both ends, notification cleared.

### 4b. Group calls

- [ ] Owner-hosted group voice: 3-way audio, FrameCryptor on every consumer, key `delivered=N`.
- [ ] Owner-hosted group video: all tiles render — **no black tile (B-01), no blank/zombie tile (B-17), no video displaced into wrong tile (B-19).**
- [ ] Non-owner-hosted call: joiner who lacks owner's key fails closed (B-13, by design — not a new bug; confirm it's the known fail-closed, not plaintext).
- [ ] Member joining an existing room sees all existing tiles (PASS baseline).

### 4c. Call lifecycle (where the NEW bugs live — test every build)

- [ ] **Screen-off during call** → call survives? (B-24: dies the instant app loses foreground.)
- [ ] **App-switch / home during call** → call survives? (B-24.)
- [ ] **Navigate call → Messenger → back** → returner keeps remote tiles + timer (B-25: loses all remote tiles + timer resets 0:00).
- [ ] **Leave call idle ~9+ min** with screen-timeout on → does it drop? (B-23 was screen-timeout masquerading as a spontaneous close.)

### 4d. Call survival (B-05) — ONLY after confirming server redeploy

- [ ] Call survives > the historical 1–24 min random-drop window? Watch for `ack_timeout:ping`, `transport not open`, `room.ended — host left`, `rejoin FAILED: ack_timeout:sfu.join`.
- [ ] If it drops: capture the drop timestamp on all devices (tight clustering = single server event) for server-log correlation.

### 4e. Camera / ring (PHYSICAL device only — BlueStacks is blind)

- [ ] Camera stolen by another app mid-call → restored on return? (B-20 — BlueStacks magenta fake-camera can't reproduce.)
- [ ] Incoming call ring with app backgrounded/killed → full-screen ring, sound, vibration (B-21 — needs full-screen-intent/callkeep on real hardware).

---

## 5. FILE VAULT

- [ ] Vault lock (PIN/biometric) gates entry.
- [ ] **MFA gate:** download URL only returns after a _fresh_ biometric/TOTP challenge, even with a valid JWT — **do not bypass** (security invariant).
- [ ] PIN reset flow (Forgot → OTP → New PIN) works.
- [ ] Files encrypt locally before upload; decrypt on download.

## 6. BACKUP & RESTORE

- [ ] Backup setup + mirror flush works.
- [ ] **Restore does NOT replay locally-deleted messages** (B-26: server sealed-archive replay resurrected 314 deleted messages). Verify deletion-awareness + dedup.
- [ ] "replay skipped" lines = decrypt failures (ratchet/key), distinguish from deletion logic.

---

## 7. BROADER SURFACE (rotate — not every build, but don't let it rot)

- [ ] **Booking flow:** ZoneMap → ServiceType → DateTime → Package → AddOns → OpsReview → Confirmation → TripSummary. Run `booking` Jest project for code-side.
- [ ] **Live tracking / SOS:** map renders, SOS emergency path.
- [ ] **Agent flows:** registration wizard → KYC → coverage → availability → approval → JobMarketplace → JobDetail → Earnings.
- [ ] **Pro subscription / Mission / VBG / Department channels / News** screens load without crash.
- [ ] **Ops Console** (Next.js, port 3002): login, mission detail, vault, map — adjacent-screen regression.

---

## 8. ERROR / EDGE PATHS (per CLAUDE.md — golden path is not enough)

- [ ] Offline send → queues + retries, no data loss.
- [ ] Permission denied (camera/location/mic) → graceful, no crash.
- [ ] Cancelled flow (mid-booking, mid-call setup) → clean teardown.
- [ ] Network degradation (high latency / packet loss) during a call → behavior (relevant to B-05 heartbeat sensitivity).
- [ ] Token expiry / 401 → silent refresh (single-flight guard), no logout storm.

## 9. SECURITY INVARIANTS — must NOT regress (stop-and-flag if any fail)

- [ ] No plaintext message body / decrypted media / key bytes in logcat (the log-audit test enforces this — spot-check live logs too).
- [ ] Sealed-sender envelope verifies (`verifySenderCert`, `verifySealedAad`) — no "skip in dev" branch.
- [ ] Group master key: rekeys on member removal; not exposed to relay.
- [ ] File Vault MFA gate present on every download URL issuance.
- [ ] Relay only transports (transient, ≤30-day dwell) — no plaintext at rest.

---

## 10. EVIDENCE + TRIAGE (close the loop)

- [ ] logcat + uiautomator screen capture for **every render/visual claim** (don't trust `handled=true`).
- [ ] Map all userId prefixes → accounts (Device & Identity Reference).
- [ ] Log delta vs previous build: which open bugs flipped PASS↔FAIL.
- [ ] New findings → next `B-##` entry in `sqa.md` (reproduce steps, log evidence, inferred root cause, files) + Summary Table row.
- [ ] For each open bug, record status as **unit✓ / build-present✓ / device-verified✓ — on THIS vc** (a bug isn't closed until all three line up on the same build).
- [ ] Inline evidence into `sqa.md` / repo (Desktop files can auto-delete).

---

## Quick regression matrix (the open bugs — run identically every build)

| Bug            | Test                                                | Where        |
| -------------- | --------------------------------------------------- | ------------ |
| B-05           | Call survival (after server-redeploy check)         | any          |
| B-01/B-17/B-19 | Group video tiles render (no black/blank/displaced) | any          |
| B-18           | Group inbound w/ + w/o key; 1:1 inbound render      | any          |
| B-22           | Group inbound from a key-less sender → not raw JSON | any          |
| B-15b          | First message on a fresh pair                       | any          |
| B-24/B-25      | Call: screen-off, app-switch, navigate-away+back    | any          |
| B-20           | Camera steal + restore                              | **physical** |
| B-21           | Background ring                                     | **physical** |
| B-26           | Restore doesn't resurrect deleted messages          | any          |
| B-04           | No ghost "Call" group in list                       | any          |

---

_Tailored to Bravo Secure from `sqa.md` + CLAUDE.md. Update the bug rows as the open set changes._
