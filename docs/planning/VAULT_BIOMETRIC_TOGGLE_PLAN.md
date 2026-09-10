# Vault Biometric Unlock — Settings On/Off Toggle (founder decision #3, 2026-08-15)

**REVISION 3 — FINAL-CANDIDATE** — Rev 2 re-reviews converged: critic REVISE with
4 narrow items (R-1..R-4) + 7 implementation guardrails; edge agent: all Rev 1
findings ADDRESSED, 7 new holes in Rev 2's own machinery (N1..N7). R-1=N3+N6,
R-2=N1, R-4=N4; §3.3b was CONCEDED by the critic to the edge agent (lane-scoped
cancel, now with R-3's two guards). All folded below; no open questions remain.

**Goal:** a durable off-ramp (and second on-ramp) for the vault's biometric unlock,
closing the B-459 follow-up. Nothing else about the lock changes.

## 1. Current state (CORRECTED per R1/P0-2)

Flag: `biometricEnabled` (`vaultStore.ts:71`), default false (:172), persisted
(:515), setter (:441).

**Writers (3):** `setupPin` forces false (`:330` — inside setupPin's set block, NOT
verifyPin); `setBiometricEnabled` (:441); **`reset()` (:491)** → initialState
(sign-out lane, `authStore.ts:748`).

**Real invariant (was mis-stated in Rev 1):** `verifyPin`'s malformed-record branch
(`:350-356`) nulls ONLY `pinHash` — **`biometricEnabled` can legally be `true`
while `pinHash` is `null`** until the next setupPin. Work item W6 closes this:
clear the flag in the malformed branch too, and pin it (clean-slate for real).

**Readers (4, all reactive):** VaultLock auto-prompt (:174-185), VaultLock key
render (:263, :312), VaultNewPin re-offer (:127). No other production reader
(critic-verified repo-wide). **Corrected impact fact (P1-6):** `BiometricGate` is
NOT "separate storage, no interaction" — `BiometricGate.tsx:383` **writes**
`useVaultStore.getState().lock()` on foreground relock; it is the vault's most
frequent relock source and drives the no-await rule in §3.2.

**Pins constraining the feature:** `vaultBiometricOptIn.test.ts:62-63` (file-scoped
counts — safe), `:93-101` (copy pin — flips WITH the feature, see §6), `:45` (raw-
prose assert on VaultNewPinScreen line ~64's sentence — do not reword that line, or
flip this pin deliberately), `:114-122` (store shape — unchanged),
`vaultLockShellExit.test.tsx` (additions only), `privacyToggleLatestWins.test.ts`
(node project imports MessengerSettingsScreen with virtual mocks — W7).

## 2. Placement & reachability (P0-1 / R5)

Row lives in `MessengerSettingsScreen.tsx`, new **FILE VAULT** section after Chat
Backup (:324-341). BUT the route `MessengerSettings` is registered in ONE shell
only, while the consent prompt fires in all three — so the off-ramp must be made
reachable everywhere BEFORE the promise copy flips:

- **W1: register `MessengerSettings`** in `AgentStackParamList`/`AgentNavigator`
  (this also fixes the pre-existing dead gear tap — `MessengerHomeScreen.tsx:776`
  bare-navigates to it and silently no-ops in the agent shell today) and in
  `DeptVaultStackParamList`/`DepartmentalNavigator`'s Vault stack (covers the CPO
  shell, which hosts Departmental). With the route real in every shell that mounts
  VaultLock/VaultNewPin, widening `VaultGateParams.next` with `'MessengerSettings'`
  no longer manufactures a phantom route — R4 is satisfied by REGISTRATION, not by
  a split param type. A pin asserts all three registrations exist (the
  types.ts:511-513 rule honoured by making the claim true, not by narrowing it).
- **W1b (R-2/N1 — MANDATORY companion):** mounting the screen in new shells
  exposes ITS outbound navigations there. MESSAGE_LOOP §5 sweep of every
  navigation in `MessengerSettingsScreen` per new host: today that is exactly the
  Chat Backup row's bare `navigate('BackupSetup')` (`:328` — registered ONLY in
  MessengerNavigator; a silent no-op in the new shells, the very Issues-18/19
  class W1 fixes) plus shell-agnostic `goBackOnce`. Resolution: **register
  `BackupSetup` transitively in both new shells** and sweep `BackupSetupScreen`'s
  own outbound targets the same way (it exits via `goBackOnce`/`leaveSetup` →
  `replace('MessengerHome')` — the Departmental Vault stack aliases
  `MessengerHome`, the Agent stack registers it: both resolve — VERIFY in
  implementation, pin the sweep result). If the transitive sweep uncovers an
  unresolvable target, fall back to hiding the Chat Backup row where its route is
  absent — never ship a compiling dead tap.
- The row: **the file's FIRST store-backed Switch** (P1-4) — `value` and visibility
  read `useVaultStore` selectors directly (`s.biometricEnabled`, `s.hasPin()`),
  no local mirror, no optimistic flip (the write is synchronous+local). A test
  mutates the store externally and asserts the switch follows.
- Visibility: `vaultHydrated() && hasPin()` (R7/P2-3), re-checked via
  `onFinishHydration` — same LOAD-BEARING hydration rule as FilesScreen/VaultScreen.
- Copy disambiguates the app-level lock (P1-6): hint ends "This is separate from
  Biometric Lock in your profile, which locks the whole app."
- NOTE (P2-6, stated-as-examined): the screen boots behind `client.me()` +
  `listBlocked()`; offline the row appears after the error path clears loading. A
  purely local switch behind a network gate is a wart, not a blocker — no refactor
  in this change.

## 3. Semantics

### 3.1 Hardware probe (P0-3 / P0-4)

- Probe = **`getEnrolledLevelAsync()`** (the pair `hasHardwareAsync`+`isEnrolledAsync`
  is BANNED for this purpose by `BiometricGate.tsx:229-247`: Android lockout /
  HW_UNAVAILABLE / SECURITY_UPDATE_REQUIRED all read as "not enrolled"). NONE →
  unavailable; BIOMETRIC_WEAK → available, but the hint names it ("face unlock on
  this device is low-security"); run on focus **AND on `AppState → 'active'`**
  (N2 — `useFocusEffect` does not fire on background→foreground; a user who
  deletes their fingerprints in device settings and returns would enable against
  a stale "available"; FilesScreen/VaultScreen pair the two listeners for the
  same reason); cache the result, **bounded** with a timeout (P2-2) — timeout ⇒
  unavailable. The probe NEVER sits on the ON write path (critic guardrail 3).
  Deliberately out of scope (critic guardrail 4): `VaultLockScreen:97-104` and
  `VaultNewPinScreen:80-86` keep the old probe pair — they fail CLOSED there
  (key hides, PIN still works): a UX wart, not BiometricGate's fail-open. Do not
  "fix" two security screens outside this change.
- **Asymmetric disable (P0-4):** when the probe fails and the flag is OFF → row
  disabled + "Add a fingerprint or face in your device settings first". When the
  probe fails and the flag is ON → row stays LIVE (OFF direction must always work)
  with "Biometric is no longer available on this device — turn this off, or
  re-enrol." Both arms pinned.

### 3.2 Toggle ON — PIN-fresh anchor (R2/R3 rewrite; the Rev 1 claim was false)

Rev 1 claimed `isUnlocked()` = "same trust anchor as today's consent prompt". FALSE
in general: the 5-minute window is also opened by `unlockWithBiometric`. The saving
structure: while `biometricEnabled === false` (the only state where ON is offered),
no biometric affordance exists, so any live window WAS PIN-opened — but a 5-minute
PIN window still permits the handoff attack (unlock for Files → hand the phone over
→ holder enrols their finger). Rev 2 therefore anchors on **PIN freshness**:

- vaultStore gains **`lastPinProofAt` (wall) AND `lastPinProofMonotonic`** — both
  stamped ONLY by `verifyPin` success, `setupPin`, and **`changePin`** (`:430` —
  reached only after typing a 6-digit PIN twice, the same presence proof; stated
  here so the omission cannot drift in later — R-1/N6). `pinFresh()` requires
  BOTH within the window AND `delta >= 0` — mirroring `isUnlocked()`'s AND
  verbatim (audit #37): `monotonicNow()` falls back to `Date.now()` where the
  Performance API is absent (rollback-freshenable alone), and `uptimeMillis`
  stops in doze (a pocketed phone stays "fresh" for 20 wall-minutes alone) —
  either single-clock reading re-opens the §3.2 handoff hole (R-1/N3). The
  rollback case is pinned (`jest.setSystemTime` harness exists). Constant:
  `PIN_PROOF_WINDOW_MS = 60_000`, declared next to `UNLOCK_WINDOW_MS`, its own
  named export, never reused. Fields live in `initialState` (so `reset()` clears
  them — the Issue 30/20 class) and STAY OUT of `partialize` — both PINNED, not
  prose (N5, guardrail 2).
- ON tap: **synchronous** — `if (flag off && pinFresh()) setBiometricEnabled(true)`
  — no await between check and write (P1-1/P1-5/P2-4 all die here: the probe result
  is the cached focus/AppState-refresh value per §3.1; nothing async sits on the
  write path, so a relock, a burst OFF-tap, or a sign-out `reset()` cannot
  interleave).
- Not fresh → the switch does not flip; Alert: "Confirm your vault PIN to enable
  biometric unlock." [Cancel] [Enter PIN] → the VaultLock lane (§3.3). After the
  round-trip the user flips again — now fresh. Two taps, one visible consent, no
  intent state carried across navigation (critic Q2), and the anchor is the PIN
  typed NOW, not a 5-minute-old window (closes R2's hole strictly).
- Capability proof (critic Q3, ProfileScreen:184-195 parity): after the
  synchronous flag write, live-fire `authenticateAsync` once; on failure revert
  the flag with honest copy. A WORKS-check, not an identity check — the PIN-fresh
  anchor is the security control. R-4/N4 hardening: the revert routes through the
  file's own **`createLatestWins`** sequencer (SET-08 — a late result must never
  clobber a newer deliberate tap: ON→OFF→ON with a stale `user_cancel` resolving
  last previously reverted a successful newer ON) and a second `authenticateAsync`
  is refused while one is pending (the native module keeps ONE promise —
  BiometricGate's `authenticating` ref + settle is the in-repo precedent). Net
  rule: the revert may write `false` AND only while it is still the latest
  request for the field.

### 3.3 The VaultLock lane

- Target resolution: never a bare hard-coded navigate from a tri-shell screen
  (Issues 18/19). `findNavigatorWithRoute(navigation, 'MessengerSettings')`;
  null → `exitToHome()` fallback (cannot strand). With W1, null is unreachable in
  practice; the fallback is belt-and-braces, pinned with a mock tree lacking the
  route (edge P0-1 amendment).
- Return leg: **`navigate`, not `replace`** (P1-2) — StackRouter pops back to the
  LIVE Settings instance (no duplicate mount, no refetch, no double-back, unsaved
  profile edits intact). `replace` stays for the Files/MessengerHome root targets.
- The no-PIN hop IS reachable (P2-1 corrects Rev 1's "unreachable"): malformed
  legacy hash → reactive redirect → VaultNewPin carries `next` whole → after setup
  the user lands back on Settings. The consent prompt may fire over Settings there;
  acceptable (the store write is screen-independent — X1 precedent), noted for the
  device pass.

### 3.3b SETTLED (critic conceded to the edge agent) — lane-scoped cancel WITH R-3 guards

When `route.params?.next === 'MessengerSettings'`, cancel pops back instead of
resetting — but `next` is caller data (it survives deep links / restored state),
so "Settings sits beneath" is a CHECKED PRECONDITION, not an assumption:

1. `navigation.canGoBack()` must be true — otherwise `goBack()` no-ops while the
   hardware-back handler still consumes the key = user HARD-STUCK on the lock
   (worse than the data loss); fall through to `exitToHome()`.
2. `navigation.getState()` must show the route directly beneath IS
   `MessengerSettings`; anything else falls through to `exitToHome()` (the
   back-trap is never defeated on an unverified param).
   Use `goBackOnce` (tapGuard), not raw `goBack` (edge nit — the neighbours do).
   THREE pinned arms in `vaultLockShellExit.test.tsx`: settings-lane-with-Settings-
   beneath → goBack; settings-lane-with-anything-else-or-nothing-beneath →
   exitToHome; every other lane → exitToHome unchanged.

### 3.4 Toggle OFF — always allowed (critic Q1 CONFIRMED, both reviewers)

`setBiometricEnabled(false)` unconditionally, synchronous, both probe arms (§3.1).
Copy adds: does not affect the app-level Biometric Lock. Residual (edge, accepted):
a force-kill inside the AsyncStorage write window can lose an OFF — fails toward
biometric staying on; one-sentence acknowledgement, no mitigation.

### 3.5 Consent prompt interplay

Unchanged mechanics. The copy flips ONLY in the same commit as W1 (the promise must
be true on every surface that shows it — edge P0-1B): "You can turn this off any
time in Settings." Re-offer after a Settings OFF at the next PIN flow: intended,
at most once per flow.

### 3.6 Device-credential fallback — SETTLED as §8 Q5 (P1-7, stop-condition)

`VaultLockScreen.tsx:106-111` passes `disableDeviceFallback: false`, so the toggle
arms "biometric OR the phone's screen-lock code". Pre-existing, but the row copy
must not lie. Rev 2: (a) row hint names it ("…or your device screen lock") — copy
only, ships now; (b) flipping the vault lane to `disableDeviceFallback: true` is an
UNLOCK-PATH change = architecture/founder sign-off, logged as a follow-up decision,
NOT in this change. §8 Q5.

## 4. Security analysis (rewritten per R2)

- OFF: removes an unlock method. Never weakens.
- ON: anchored on a ≤60s-old PIN proof — strictly TIGHTER than Rev 1's 5-minute
  window and equivalent-or-tighter than today's consent prompt (which fires seconds
  after PIN entry). No claim of "same anchor" — the anchor is stated exactly.
- No new unlock path in Settings: no `unlockWithBiometric`, and no navigation from
  Settings into VaultScreen/Files content (asserted at the DECISION SITE, not a
  blanket `authenticateAsync` token ban — the §3.2 capability proof needs the
  token) (R9).
- Documented cost (P2-5): the VaultLock round-trip opens the normal 5-minute
  window (no verify-without-extending mode exists) — the user has simply unlocked
  their vault, as any PIN entry does.
- Store self-write inventory after W6: setupPin→false, malformed-verify→false
  (new), reset()→false. Every non-consent writer forces OFF.

## 5. Impact map (corrected)

| Consumer                                  | Change                                                                                                                                         | Risk                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| VaultLock auto-prompt / key render        | none (reactive store reads — verified)                                                                                                         | none                              |
| VaultNewPin consent (:127)                | copy flip, same commit as W1                                                                                                                   | pin flips, documented             |
| vaultStore                                | +`lastPinProofAt` AND `lastPinProofMonotonic` (both in `initialState`, both OUT of `partialize`, both pinned) + W6 malformed-branch flag clear | additive; W6 pinned               |
| BiometricGate                             | none to it — but it WRITES vaultStore.lock(); drives §3.2's no-await rule; double-prompt UX noted for device pass                              | copy disambiguation               |
| FILES/Vault gates                         | none (read isUnlocked/hasPin only — verified)                                                                                                  | none                              |
| MessengerSettingsScreen                   | +1 section; first store-backed Switch                                                                                                          | render + W7 test mocks            |
| AgentNavigator / Departmental Vault stack | +MessengerSettings AND +BackupSetup registrations (W1/W1b; also FIXES the dead gear tap) + whatever the transitive §5 sweep adds               | new routes mount existing screens |
| privacyToggleLatestWins.test.ts (node)    | needs `{virtual:true}` mocks for `@/modules/messenger/vault` + `expo-local-authentication` (W7)                                                | test-only                         |

## 6. Work items & test plan (RED-first; every mutation VERIFIED APPLIED by grep before trusting a result)

W1 route registrations (+ pin: all three shells register MessengerSettings; union
widening legal only because of it). W2 the Settings row (store-backed, hydration-
gated, asymmetric probe arms). W3 the ON lane (pinFresh anchor + Alert + resolver
navigate + capability proof w/ fail-safe revert). W4 VaultLock: `next:
'MessengerSettings'` forward on BOTH legs (VaultLock + VaultNewPin) via `navigate`;
lane-scoped cancel per §3.3b outcome. W5 copy flips (consent prompt + optIn pins
:93-101 AND the same-commit toggle-existence scan — flipping a promise pin without
enforcing the new promise is the B-459 shape itself; prose pin :45 handled without
rewording line ~64, or flipped deliberately). W6 malformed-branch flag clear +
store pin. W7 node-test virtual mocks. W8 test-plan CSV rows VAULT-07/09/23
(VAULT-23 is already stale — says "greyed+disabled", code hides the key) + close
the B-459 "no settings toggle" line in sqa.md.

New suite `vaultBiometricToggle.test.ts` — **source-scan** (decided, R9: no render
test exists for this screen and the node project can't mount it; CRLF + prose-heavy
file ⇒ use vaultBiometricOptIn's stripper): row visibility (hydrated+hasPin); both
probe arms (P0-4); ON is synchronous-guarded on pinFresh and never awaits before
the `true` write; OFF unconditional; the locked lane navigates via the resolver
with the exitToHome fallback; no-unlock-path decision-site scan; store-follows
test for the Switch; round-trip `next` pins both legs; W6 pin; registration pins.
PLACEMENT (critic): the `pinFresh()` ARITHMETIC pins (dual-clock AND, rollback,
doze, negative-delta) live in `vaultStore.test.ts` under the messenger-crypto
project — that is where the `jest.setSystemTime` harness is — NOT in the
`vaultBiometricToggle` source scan.
Plus: `git diff` self-review per CLAUDE.md rule 8 (three writers of a persisted
security flag — enumerate all 5 readers against the final diff: the 4 existing
plus the new Switch's own `value` selector) and the DESIGN_REVIEW_LOOP pass for
the new row (fontScale ≥1.3, 320dp) (R9).

## 7. Gates & device pass

Jest: app screens/messenger + messenger-crypto ×2 (flake rule) + tsc ≤47 + eslint.
Device: ① ON while PIN-fresh → immediate, lock screen shows key + auto-prompts;
② ON while stale → Alert → PIN → back on the SAME Settings instance (edits intact)
→ flip → ON; ALSO the fumbled round-trip (N7): burn the 60s window on the keypad
(slow typing / a 30s lockout tier) → the Alert simply re-offers, no dead end; ③ OFF → key gone, auto-prompt silent, PIN works; ④ probe-fail arms
(enrol/unenrol mid-session, Android lockout after 5 failed device attempts);
⑤ agent-shell gear tap now opens Settings (W1 side-fix); ⑥ dept/CPO shell reaches
Settings from the Vault tab; ⑦ double-prompt UX with app-level lock ON (P1-6, note
only); ⑧ consent copy names Settings on every shell.

## 8. Questions — ALL SETTLED (Rev 3)

1. OFF gated? — unconditional (both reviewers).
2. §3.3b cancel — lane-scoped goBack with R-3's two guards (critic conceded).
3. pinFresh window — 60s ACCEPTED, conditional on the AND'd dual-clock pair
   (R-1); N7's fumbled-round-trip case (Argon2id + 30s lockout tier can outlast
   the window → the Alert simply re-offers, by design) added to device pass ②.
4. superseded by 2.
5. Device-credential fallback — copy names it now ("…or your device screen
   lock"); `disableDeviceFallback:true` for the vault lane = arch-gated FOUNDER
   DECISION, logged in sqa.md, not in this change.

## 9. Critic implementation guardrails (verbatim obligations for the fixer)

G1 do NOT touch `VaultLockScreen.tsx:163-167` (the focus-forward makes the
two-tap flow terminate). G2 `lastPinProof*` stays OUT of `partialize` (pinned).
G3 the probe never sits on the ON write path. G4 the two security screens keep
their fail-closed probe pair (§3.1). G5 W5 is ATOMIC: copy flip + existence scan

- W1/W1b in one commit. G6 `vaultBiometricOptIn.test.ts:45` pins the raw prose of
  VaultNewPinScreen line ~64 — rewrite the surrounding block (its ":74-76 no off
  switch anywhere" claim goes false) WITHOUT rewording line 64, or flip that pin
  deliberately in the same commit. G7 crypto project ×2; expect W7's first failure
  shape to be module-RESOLUTION (messenger-crypto has no module-resolver — hence
  `{virtual: true}` mocks), not a mock error.

## Changelog Rev 2 → Rev 3 (FINAL — critic AGREE-PROCEED + edge ADDRESSED-ALL)

R-1/N3/N6: pinFresh dual-clock AND + delta>=0 + named constant + changePin stamp.
R-2/N1: W1b transitive BackupSetup registration + §5 sweep + hide-row fallback.
R-3: §3.3b settled with canGoBack + route-beneath guards, three pinned arms.
R-4/N4: createLatestWins + single-pending-prompt on the capability revert.
N2: probe on focus AND AppState-active. N5: initialState/partialize pins.
N7: fumbled-round-trip in device pass ②. §9 guardrails G1-G7. Edge doc-nits 1-6
and critic doc-nits folded (impact-table dual fields, +BackupSetup row, §3.6
heading, reader count 5, pin placement note).

## Changelog Rev 1 → Rev 2

R1/P0-2 writer map corrected (3 writers; verifyPin never touched the flag; real
invariant stated; W6 added). R2/R3 isUnlocked anchor replaced by pinFresh(60s) +
synchronous write; equivalence claim retracted. R4 satisfied via W1 registrations
instead of union-splitting. R5/P0-1 off-ramp made reachable in all shells; copy
flip tied to W1; resolver + fallback for the forward. R6/W7 node-test mocks. R7/
P2-3 hydration gate. R8/W5 complete pin-flip set + same-commit enforcement scan.
R9 test plan rewritten (source-scan decision, decision-site absence scan, both-leg
round-trip, mutation-verify language, design gate). P0-3 probe API corrected to
getEnrolledLevelAsync. P0-4 asymmetric disable. P1-2 navigate-not-replace. P1-3/Q4
disagreement surfaced as §3.3b with recommendation. P1-4 store-backed Switch. P1-6
impact table corrected + copy disambiguation. P1-7 §3.6/Q5. P2-1 "unreachable"
retracted. P2-2 bounded probe. P2-5 window cost documented. P2-6 noted. Critic
additions: CSV/sqa.md items (W8), ProfileScreen discoverability noted (copy
cross-reference only; row stays in Messenger Settings), rule-8 self-diff item.
