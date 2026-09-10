# Test Plan — v1.0.92 / vc118 (audit remediation build)

Build: Firebase App Distribution → **qa** group, staging backend
(`auth.94-136-184-52.sslip.io` / `relay.94-136-184-52.sslip.io`).

**Golden rule for the flag-gated features:** test with the flag **OFF first**
(must behave exactly like today), then turn it **ON** and re-test. If anything
regresses with a flag ON, either turn the flag off or `git revert` that commit —
nothing is coupled.

Flags (set as `EXPO_PUBLIC_*` at build time, or backend env):

| Flag                                    | Feature                 | Commit  |
| --------------------------------------- | ----------------------- | ------- |
| `EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE` | TOFU send-gate          | 73ad6f3 |
| `EXPO_PUBLIC_RESEND_PROTOCOL`           | Resend protocol ⚠️      | c0f572c |
| `EXPO_PUBLIC_MULTI_DEVICE`              | Multi-device fan-out ⚠️ | 79a4551 |
| `WS_SESSION_RECOVERY` (backend)         | WS connection recovery  | 73ad6f3 |

---

## A. Core smoke — nothing regressed (do this first, flags all OFF)

| #   | Test                     | Steps                             | Expected                         | Devices |
| --- | ------------------------ | --------------------------------- | -------------------------------- | ------- |
| A1  | 1:1 messaging            | Send/receive text both directions | Delivers + renders, ✓✓ ticks     | 2       |
| A2  | Group messaging          | Send in a synced group            | All members render               | 3       |
| A3  | 1:1 voice/video call     | Call, answer, talk, hang up       | Connects, audio/video, clean end | 2       |
| A4  | Push wake (backgrounded) | Background app, send a message    | Notification appears             | 2       |
| A5  | Push wake (killed)       | Swipe app away, send a message    | Notification appears             | 2       |
| A6  | First-contact message    | Message a brand-new contact       | Session establishes, delivers    | 2       |

---

## B. Notification fixes (Push 1)

| #   | Test                                     | Steps                                                                                   | Expected                                                                   |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| B1  | **Killed-app SOS/mission wake** (CRIT-5) | Swipe app away, trigger an SOS / mission-dispatch / booking-approved event to that user | Notification surfaces (previously dropped when killed)                     |
| B2  | **Foreground in-app push**               | Keep app open on chat A; trigger a booking/SOS event                                    | Notification/banner shows (previously nothing)                             |
| B3  | **Cold-launch tap routing**              | Kill app, receive a message push, tap the notification                                  | Opens the **conversation** (not home), thread loads                        |
| B4  | **Missed-call notification**             | Call the device; cancel before answer (or let it ring out)                              | Persistent "Missed call" notification appears                              |
| B5  | **Dismiss-on-read**                      | Receive a message (banner shows) → open that chat                                       | Banner clears when the thread opens                                        |
| B6  | **Notification icon**                    | Any notification (message/call/missed)                                                  | Small status-bar icon = monochrome shield, **not a white square/launcher** |
| B7  | **Single permission prompt**             | Fresh install → onboarding + login                                                      | `POST_NOTIFICATIONS` asked **once**, not twice                             |
| B8  | **CallKit leak**                         | Log out → log back in → receive + answer a call                                         | Answer fires **once** (no double-answer / double-hangup)                   |
| B9  | **Presence stays online**                | Stay connected on one device > ~1h                                                      | Peers still see you **online** (not falsely offline)                       |
| B10 | **Lock-screen call resume**              | Active call → background → lock → tap the ongoing-call notification                     | App shows **over** the lock screen, screen turns on                        |

---

## C. ⚠️ RISKY #1 — Resend protocol (`EXPO_PUBLIC_RESEND_PROTOCOL`)

**What it does:** when a peer's session breaks and rebuilds, the sender
re-transmits its recent still-undelivered 1:1 **text** messages to that peer.

**Setup:** 2 devices (A = sender with flag ON, B = receiver). Backend staging.

| #   | Test                  | Steps                                                                                                                                      | Expected (PASS)                                                                        | FAIL signs → action                                          |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| C1  | Flag OFF baseline     | Build with flag OFF; break+heal a session (reinstall B), A messages during break                                                           | Behaves exactly like today (tombstone / manual resend); **no** auto-resend             | any behavior change → investigate                            |
| C2  | Happy path resend     | Flag ON. On B: clear app data / reinstall (breaks its session). A sends 2–3 texts to B. Reopen B (it rebuilds session + sends rehandshake) | B receives the messages A sent during the break; **exactly one copy each**             | duplicates on B, or missing → note + consider revert c0f572c |
| C3  | No duplicate storm    | After C2, watch A for ~2 min                                                                                                               | A re-transmits **once** per healed session (60s per-peer cooldown); no repeated bursts | repeated re-sends / battery drain → revert c0f572c           |
| C4  | Attachments untouched | During the break, A sends a photo                                                                                                          | Photo is **not** auto-resent (text-only by design); no crash                           | crash/odd behavior → note                                    |
| C5  | Bounded               | A sends >10 texts during a long break, then B heals                                                                                        | At most ~10 most-recent re-transmitted (cap)                                           | unbounded resend → revert                                    |

**What could break:** duplicate messages, message loss, resend storms, or a
crash on the receive path. If C2/C3 misbehave, the safest action is to turn the
flag off (behavior returns to today) or `git revert c0f572c`.

---

## D. ⚠️ RISKY #2 — Multi-device fan-out (`EXPO_PUBLIC_MULTI_DEVICE`) — HIGHEST RISK

**What it does:** a 1:1 send also delivers to the peer's **other** devices
(beyond device 1). The primary device-1 send is unchanged; the fan-out is
additive and best-effort.

**Setup:** peer **B has TWO devices** (B1, B2) — log the same B account in on two
phones; each registers a distinct `signal_device_id`. A = sender.

| #   | Test                                     | Steps                                         | Expected (PASS)                                                  | FAIL signs → action                                                                                          |
| --- | ---------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D1  | **Flag OFF baseline (CRITICAL)**         | Build with flag OFF. A sends to B (2 devices) | B1 receives (today's behavior). B2 may not — that's expected off | if B1 does NOT receive → the send path broke, **revert 79a4551 immediately**                                 |
| D2  | Flag ON — primary still works (CRITICAL) | Flag ON. A sends a text to B                  | **B1 receives** (primary send must be unaffected)                | B1 stops receiving → **revert 79a4551 immediately** — this is the one thing that must never break            |
| D3  | Flag ON — second device receives         | Same send as D2                               | **B2 ALSO receives** the message (the fix)                       | B2 doesn't receive → fan-out not working, but if B1 is fine it's **safe** (no data loss); note for follow-up |
| D4  | No duplicates on a device                | Watch B1 and B2                               | Each device shows **one** copy (same clientMsgId dedups)         | duplicate bubbles → note + consider revert                                                                   |
| D5  | Sender stable                            | Send several messages A→B with 2 devices      | A never hangs/crashes; primary sends stay fast                   | A errors/slow → the fan-out is best-effort/async, but if it affects A → revert                               |
| D6  | Reinstall device                         | Reinstall B2 (new device id), A sends         | New B2 receives after its bundle is live (within ~90d window)    | —                                                                                                            |

**What could break (why this is #1 risk):** if the fan-out were wrong it could
disturb the **primary** send and break decryption for the peer's main device.
The design prevents this (fan-out runs _after_ the primary send, isolated,
best-effort), but D1/D2 are the make-or-break checks: **B1 must always receive.**
If it ever doesn't, `git revert 79a4551` — that removes only the fan-out and
leaves everything else intact.

---

## E. TOFU send-gate (`EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE`) — low risk

| #   | Test                              | Steps                                                         | Expected                                                                          |
| --- | --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| E1  | Flag OFF                          | Reinstall peer (identity rotates), send to them               | Sends normally (today's behavior)                                                 |
| E2  | Flag ON — gate blocks             | Flag ON. Peer reinstalls (safety number changes). Try to send | Send is **blocked** with a "security code changed — review before sending" notice |
| E3  | Flag ON — accept clears           | Verify the peer / accept the change                           | Sending resumes to that peer                                                      |
| E4  | Flag ON — normal peers unaffected | Send to a peer whose identity did NOT change                  | Sends normally                                                                    |

---

## F. Backend (verify via behavior + logs)

| #   | Test                                     | Expected                                                                                                           |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| F1  | Push scaling (CRIT-1)                    | Pushes still deliver; server logs no keyspace-SCAN per send                                                        |
| F2  | WS recovery (`WS_SESSION_RECOVERY=true`) | Brief network blip → typing/presence resume without a full re-pull (staging, multi-client)                         |
| F3  | Presence TTL                             | Long-lived socket not falsely reaped to offline                                                                    |
| F4  | B-39 OTP prod guard                      | In a **production** env, `OTP_DEV_BYPASS=true` is ignored (real OTP enforced); staging still allows the dev bypass |

---

### Revert cheat-sheet (each is independent)

- Multi-device issue → `git revert 79a4551`
- Resend issue → `git revert c0f572c`
- Anything in the safe batch → `git revert 73ad6f3` (or just leave flags off)
- Patch fix (keep) → `d22f0ec` is infra hygiene; don't revert unless builds break
