# Messenger Frontend UX / Smoothness Audit · 2026-07-16

**Scope:** messenger client only (`src/screens/messenger/`, `src/modules/messenger/`,
`src/navigation/`) — backend explicitly out of scope (founder: "backend is solid").
**Trigger (founder report, 4 items):**

1. Messenger doesn't feel WhatsApp-smooth on the frontend.
2. Double tick — "maybe it's licensed by Meta"; wants great-looking alternatives if so (§5).
3. Bug: open a chat → back lands on the home dashboard, not the chat list.
4. Multi-photo selection needed (with proper UI), pinch-zoom in the photo viewer,
   and "Move to Vault" from the viewer does nothing.

**Status:** **FIXED 2026-07-16 (same day)** — B-85, B-86, B-87 and MX-03..MX-13 all remediated;
see §7 (fix log) and the B-85/86/87 UPDATE entries in `sqa.md`. Gates: tsc 46 = 46 vs main
(signature-diffed, zero introduced), eslint 0 errors on touched files, messenger module suites
149/149 green incl. new chatListItems (8), zoomMath (9), pickedAssets (4), vaultMoveGuard (14),
navigatorConfig (3). **On-device verify pending** (inverted-list feel, gestures, vault MFA on
staging). Logged as **B-85 / B-86 / B-87** in `sqa.md`.

**Cross-check:** all six perf P1s from `MESSENGER_AUDIT.md` 2026-07-06 (M-13…M-18 — countdown
re-render, unbatched commits, lost optimistic bubble, unbounded media downloads, whole-map
subscriptions) were verified **fixed in current code**. Everything below is new / still open.

---

## 1 · B-85 — Back from chat lands on Dashboard, not the chat list ⚠️ P1

**Repro:** tap a message notification (or enter a chat via a cross-tab hop) while the
Messenger tab was never opened this session → ChatScreen → back → **Dashboard**.
Entry via the chat list itself is NOT affected — which is why it feels intermittent.

**Root cause:** `src/navigation/MessengerNavigator.tsx:42` has **no
`initialRouteName="MessengerHome"`**. Notification deep-links
(`src/modules/messenger/push/fcmBootstrap.ts:896-899`, `:640-643`) and the ops cross-tab hop
(`src/screens/ops/OpsMissionDetailScreen.tsx:124-131`) navigate `Main → MessengerTab → Chat`
while the lazily-mounted messenger stack doesn't exist yet, so React Navigation seeds the stack
as **`[Chat]` alone** — nothing underneath. `ChatScreen.tsx:1204` `goBack()` (and hardware back;
no BackHandler override exists) has nothing to pop, bubbles to the Tab navigator, and
`backBehavior="history"` (`MainNavigator.tsx:650`) returns to the previously-focused tab =
Dashboard. If the user opened Messenger earlier in the session, the stack is
`[MessengerHome, Chat]` and back works — classic cold-deep-link signature.

**Fix direction (1 line):** add `initialRouteName="MessengerHome"` to the Stack.Navigator in
`MessengerNavigator.tsx:42` — React Navigation then seeds MessengerHome beneath the deep-linked
Chat. (Same shape benefits the incoming-call deep-link at `MainNavigator.tsx:501-515`. The
agency shell reaches Chat via the flat AgentNavigator — unaffected.)

**Entry-path matrix (evidence):**

| Entry                    | Call site                                        | Stack built                | Back lands on    |
| ------------------------ | ------------------------------------------------ | -------------------------- | ---------------- |
| Chat-list row            | `MessengerHomeScreen.tsx:354`                    | `[MessengerHome, Chat]`    | chat list ✅     |
| NewChat / Groups         | `NewChatScreen.tsx:123+`, `GroupsScreen.tsx:160` | `[MessengerHome, …, Chat]` | ✅               |
| **Message notification** | `fcmBootstrap.ts:896-899`                        | `[Chat]` (cold)            | **Dashboard ❌** |
| **Missed-call → thread** | `fcmBootstrap.ts:640-643`                        | `[Chat]` (cold)            | **Dashboard ❌** |
| **Ops cross-tab hop**    | `OpsMissionDetailScreen.tsx:124-131`             | `[Chat]` (cold)            | prior tab ❌     |

---

## 2 · B-86 — "Move to Vault" does nothing ⚠️ P1 (deliberate fail-closed stub; pipeline exists but is unwired)

**Repro:** open any image/file in the viewer → tap **Move to Vault** → alert
"Vault upload coming soon" → nothing happens. Same on `FilesScreen.tsx:171-193`.

**Root cause:** `src/modules/messenger/ui/vaultMoveAction.ts:14-19` returns
`{kind:'blocked'}` for any file not already in the vault. This is **intentional** (audit
M-02/S1): the old implementation persisted a fake `VaultFile{keyB64:'', ivB64:'',
uri:<plaintext temp>}` — i.e. _pretended_ encryption — so adding was gated off fail-closed
until the real pipeline is wired. The invariant is locked by
`src/modules/messenger/__tests__/vaultMoveGuard.test.ts`.

**The real pipeline already exists on BOTH ends — nothing connects the button to it:**

- Client `VaultClient` (`src/modules/messenger/vault/vaultClient.ts:47-85`): local AES
  encrypt → `POST /vault/upload-url` → presigned PUT; download+decrypt mirror; sends
  `X-Mfa-Proof` on every call. **`new VaultClient` appears nowhere in the app.**
- Server (`apps/messenger-service/src/vault/vault.controller.ts:23-55` + `vault.service.ts` +
  `mfa.guard.ts`): `JwtHttpGuard + MfaGuard`-protected upload/download-url endpoints with real
  S3/R2 presigning (60 s TTL) and audit log. Live.

**Fix direction (order of work):** (1) host-side MFA challenge (biometric →
TOTP action-token per `vaultClient.ts:3-16` header doc — **the File Vault MFA gate must NOT be
bypassed**, per security constraints); (2) instantiate `VaultClient`; (3) read decrypted local
bytes → `uploadEncrypted(bytes, mime, mfaProof)`; (4) persist returned
`{objectKey,keyB64,ivB64,…}` via `useVaultStore().addFile` keyed `msg:<file.id>`; (5) flip
`resolveVaultMoveAction` to allow `add` and update `vaultMoveGuard.test.ts` to the new
invariant (real key material required, never empty keyB64). This touches the vault MFA
surface → **verify against the System Architecture Documentation before implementing.**

---

## 3 · B-87 — Media UX gaps: single-photo picker · no viewer zoom ⚠️ P2 (feature gaps, confirmed)

### MX-03 · Photo viewer has zero zoom

Tapping an image renders a **plain `<Image resizeMode="contain">` in a Modal** —
`src/modules/messenger/ui/FileViewer.tsx:151-158`, fixed frame `styles.image:396`. No pinch,
no double-tap, no pan: grep for `Gesture.`/`Pinch`/`Pan`/`useSharedValue` across `src` = 0 hits.
No gallery/zoom lib installed — but **`react-native-gesture-handler ~2.28` and
`react-native-reanimated ~4.1` are already dependencies** (unused in messenger), so
pinch+double-tap+pan can be built without adding a package (or drop in
`react-native-awesome-gallery`). Note reanimated is currently unused anywhere in messenger —
first-use will exercise the babel plugin config on this surface.

### MX-04 · Photo picking is hard-wired to ONE asset, end to end

- Picker: `ChatScreen.tsx:1026-1029` `launchImageLibrary({mediaType:'mixed',
selectionLimit: 1, …})`; only `res.assets?.[0]` is read (`:1030`).
  (`react-native-image-picker`: `selectionLimit: 0` = unlimited, returns `assets[]`.)
- Send: `sendPickedMedia` (`ChatScreen.tsx:940-997`) takes a single `(uri, mime, kind, meta)`;
  `rt.sendMedia` (`productionRuntime.ts:~2960-3020`) mints one bubble + one
  `MediaClient.uploadEncrypted` + one sealed attachment per call. Message model is
  single-attachment (scalar `media_object_key`/`media_key`/`media_iv` on `LocalMessage`).
- Render: one bubble per image (`ChatScreen.tsx:1849-1878`, `:2117-2182`); no album/grid layout.
- **No pre-send preview exists** — picking sends immediately.

**Fix shape (multi-select, "properly shown to UI"):**

1. `selectionLimit: 1 → 0` (or a bounded 10, WhatsApp-style) and iterate `res.assets`.
2. Net-new **preview/caption tray** before send (thumbnails strip + per-item remove + send-all)
   — this is what makes multi-select feel intentional rather than a burst of accidental sends.
3. Send loop over `sendPickedMedia` (sequential, respecting the `sendingMedia` flag at `:938`)
   → N bubbles; **no runtime/protocol change needed.**
4. Optional larger step (separate task): WhatsApp-style album bubble (2×2 grid) — requires a
   multi-attachment message shape or client-side grouping of consecutive image bubbles; the
   E2EE envelope/model change makes this a design-reviewed change, not a quick win.

---

## 4 · Smoothness findings (MX-05 … MX-13) — "why it doesn't feel like WhatsApp"

Ranked; P1 = visibly janky in daily use, P2 = polish gap, P3 = nice-to-have.

| ID        | P      | Finding                                                                                                                                                                                                                                       | Evidence                                                                                              | Fix direction                                                                                                                                                      |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MX-05** | **P1** | **Non-inverted chat list + 4-shot `scrollToEnd` on open** → every chat open first paints the OLDEST 20 rows, then hard-snaps to bottom at 0/80/250/500 ms. THE biggest single feel-gap vs WhatsApp (inverted lists land at bottom instantly). | `ChatScreen.tsx:199-208` (non-inverted by design note), `:548-558` (timer scroll shots), `:1286,1315` | Invert the list (reverse data + `inverted`); deletes the timer hack; pagination becomes plain `onEndReached` instead of the `<200 px` onScroll heuristic (`:1168`) |
| **MX-06** | **P1** | Swipe-to-reply runs every drag frame over the JS bridge (`PanResponder` + `Animated.Value.setValue`) — stutters under load (drain, ticks). Reanimated 4 is installed but unused in messenger.                                                 | `ChatScreen.tsx:2012-2029`; `package.json` reanimated ~4.1.1, 0 imports in messenger                  | Move to `Gesture.Pan` worklet on the UI thread                                                                                                                     |
| MX-07     | P2     | `listItems` (day separators / unread divider) rebuilt O(N) on ANY single message mutation — a lone read-tick flip re-walks the whole thread.                                                                                                  | `ChatScreen.tsx:1090-1109` (`useMemo` dep `[messages]`)                                               | Incremental/diffed separator memo                                                                                                                                  |
| MX-08     | P2     | All haptics via `Vibration.vibrate(ms)` (10 call sites) — no impact/selection API; iOS ignores duration (full ~400 ms buzz per send/long-press). WhatsApp uses light impact taps.                                                             | `ChatScreen.tsx:688,757,881,931,1432,…`; no haptics lib in package.json                               | Adopt `react-native-haptic-feedback` / `expo-haptics` (impactLight/selection)                                                                                      |
| MX-09     | P2     | Media send has no optimistic bubble — composer blocks on full encrypt+upload ("Encrypting & sending attachment…") before anything appears; text already has the pending-state machine.                                                        | `ChatScreen.tsx:1460-1465`; matches open P2 in `MESSENGER_AUDIT.md`                                   | Append media bubble immediately with a determinate upload-progress overlay                                                                                         |
| MX-10     | P2     | `data:image/jpeg;base64,…` thumb URI string rebuilt per bubble render; thumb bytes resident in the Zustand store — churn on media-heavy threads.                                                                                              | `ChatScreen.tsx:1879`                                                                                 | Memo the data-URI by message id; consider blurhash                                                                                                                 |
| MX-11     | P3     | `scrollEventThrottle={80}` lags at-bottom detection + near-top pagination by up to ~5 frames.                                                                                                                                                 | `ChatScreen.tsx:1340`                                                                                 | 80 → 16 (handler only mutates a ref + a boolean)                                                                                                                   |
| MX-12     | P3     | Inline `renderItem` closure re-created per ChatScreen render (memo comparator absorbs re-renders, but visible cells re-run comparison each keystroke).                                                                                        | `ChatScreen.tsx:1344`                                                                                 | Hoist to `useCallback` w/ ref-mirrored deps                                                                                                                        |
| MX-13     | P3     | "Chat" is ALSO registered in AgentNavigator without the polish options (`freezeOnBlur`, `slide_from_right` 220 ms) MessengerNavigator sets → agency-shell chats get default transitions, no screen-freeze.                                    | `AgentNavigator.tsx:253` vs `MessengerNavigator.tsx:42-62`                                            | Lift shared screenOptions config                                                                                                                                   |

### Already GOOD — do not re-fix (verified in current code)

- FlatList tuned: `windowSize=11`, batch 20, `removeClippedSubviews` (Android),
  `maintainVisibleContentPosition` (older-prepend doesn't jump), stable keyExtractor,
  `onScrollToIndexFailed` retry (`ChatScreen.tsx:1286-1343`).
- Bubbles memoized w/ tight comparator (`:1792-1805`) — keystrokes/socket/ticks re-render only
  the changed bubble. Countdown = shared 1 Hz `useSyncExternalStore`, unarmed bubbles no-op
  (`:2333-2357`, M-13 fix).
- Optimistic TEXT send: bubble appended before crypto, imperative EditText clear (B-73),
  retry chip on failed (`productionRuntime.ts:2663-2699`, `ChatScreen.tsx:670-681`).
- Narrow Zustand selectors on both screens (M-18 fix); coalesced 50 ms store commits (M-14).
- Media: blurred real-thumb placeholder + aspect ratio from sealed `media_meta`, "Decrypting…"
  lock, max-4 download semaphore + single-flight + warm-file reuse (`useAttachmentUri.ts:49-122`).
- All entry/burn/pulse animations `useNativeDriver:true`; TypingBubble native loop, stops when
  hidden. Messenger stack: `freezeOnBlur`, native slide 220 ms, swipe-back enabled.
- MessengerHome: memoized rows + comparator, hydration gate (no empty-flash), per-row presence
  dot, media-glyph previews. No pull-to-refresh — intentional (live socket drain).

---

## 5 · Double tick — licensing question + alternatives

**Answer: ticks are NOT licensed by Meta.** Check-mark delivery states are a generic,
unprotectable UI convention — Telegram, Viber, WeChat and others all use single/double ticks;
there is no patent or license fee attached to the _concept_. The only (thin) risk is **trade
dress**: cloning WhatsApp's exact rendering — their specific glyph geometry + their blue
`#53BDEB` on their bubble green. Bravo is already clear of that: `ChatScreen.tsx:2458-2474`
uses MaterialCommunityIcons `check` / `check-all`, muted for sent/delivered, **brand cyan
`Bravo.glow #7ED6FF` for read**, plus states WhatsApp doesn't have (`progress-clock` sending,
red `alert-circle` for failed/undelivered instead of a lying single tick). Current state:
already differentiated, no legal need to change.

**If a more distinctive look is wanted anyway (all fit obsidian/cobalt):**

1. **Recommended — keep tick grammar, brand the read state harder:** animate the
   delivered→read transition (ticks sweep to a cobalt `#5B8DEF` pill / glow-cyan fill,
   120 ms native-driver). Zero user relearning, clearly "Bravo". Cheapest.
2. **Signal-style circle progression:** hollow circle (sending) → circle-check (sent) →
   double circle-check (delivered) → filled circles (read). Distinct from WhatsApp at a
   glance; MaterialCommunityIcons has all glyphs (`circle-outline`, `check-circle-outline`,
   `check-circle`).
3. **iMessage-style microcopy** under your newest message only: "Delivered" / "Read 14:32"
   (keep tiny ticks on older bubbles). Reads premium; costs one line of vertical space.
4. **Messenger-style read avatar:** recipient's mini avatar slides to the last-read position.
   Most "alive", but heaviest (needs per-conversation read-position tracking in the UI) —
   group-chat semantics get complicated. Not recommended for v1.

---

## 6 · Suggested fix order (when approved)

1. **B-85** one-line `initialRouteName` (trivial, P1 user-facing) + regression: notification
   deep-link on cold app → Chat → back → MessengerHome; chat-list path unchanged.
2. **MX-05** inverted list (single highest-leverage smoothness win; deletes the scroll hack;
   re-verify reply-jump `scrollToIndex`, unread divider, `maintainVisibleContentPosition`,
   pagination, B-73 burst behavior).
3. **B-87/MX-04** multi-select + preview tray; **MX-03** pinch-zoom viewer (existing
   gesture-handler + reanimated).
4. **B-86** vault wiring (MFA gate — architecture-doc review REQUIRED first).
5. MX-06/07/08/09/10 polish batch, then P3s.

Device matrix per `DESIGN_REVIEW_LOOP.md`; regression watch: B-73/74 rapid-burst behavior,
B-17 class (list/render races), messenger-crypto suite for anything touching
`productionRuntime.ts` + manual 1:1/group send-receive smoke.

---

## 7 · Fix log — 2026-07-16 (same day)

| Finding           | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-85**          | TWO-part fix (the adversarial review caught that the prop alone is a no-op): `MessengerNavigator.tsx` `initialRouteName="MessengerHome"` **PLUS `initial: false` on every Chat deep-link** (`fcmBootstrap.ts` message-tap + missed-call-tap, `OpsMissionDetailScreen.tsx` cross-tab hop) — React Navigation's nested `screen` param otherwise OVERRIDES initialRouteName on first mount (verified in `@react-navigation/core` useNavigationBuilder), which was the exact bug. MX-13 rider: AgentNavigator Chat route gains `freezeOnBlur` + native slide. All locked by `src/navigation/__tests__/navigatorConfig.test.ts` (source-audit style, incl. the `initial: false` sites).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **MX-05**         | ChatScreen FlatList → **inverted** (data built chronologically then reversed in new pure module `src/modules/messenger/ui/chatListItems.ts`, unit-tested incl. separator adjacency + unread-divider placement after reversal). 4-shot `scrollToEnd` timer deleted; open lands on newest instantly. Pagination = `onEndReached` (older pages APPEND in inverted coords → zero shift, no anchor work); `maintainVisibleContentPosition={{minIndexForVisible: 0, autoscrollToTopThreshold: 80}}` gives native at-bottom follow for incoming messages; empty state via `ListEmptyComponent` (counter-flipped since RN 0.72 fix); typing bubble = ListHeader (visual bottom). `scrollToIndex` viewPositions flipped for inverted coords (0.7 ≈ 30% from visual top).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **MX-06**         | Swipe-to-reply: PanResponder → RNGH `PanGestureHandler` + `Animated.event(useNativeDriver)` — drag frames stay on the UI thread. `activeOffsetX=16 / failOffsetX=-16 / failOffsetY=±14` so vertical scroll + left drags stay with the list; clamp moved into a native interpolation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **MX-07**         | Row objects identity-stable across rebuilds (WeakMap keyed on the message object + capped separator cache) — a single status flip re-renders one bubble. Unit-tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **MX-03 (B-87b)** | New `ZoomableImage` (classic RNGH Pinch/Pan/Tap + core Animated native driver — **no reanimated**: worklets babel plugin isn't configured; release math reads gesture-event payloads, no Animated listeners). Pure clamp geometry in `zoomMath.ts` (unit-tested). Hosted in `FileViewer` inside `GestureHandlerRootView` (RNGH-in-Modal requirement); no-op Pressable claims image taps so backdrop-close can't race the double-tap. Pinch 1–4× with rubber-band, pan clamped to visible bounds, double-tap 1×↔2.5×.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **MX-04 (B-87a)** | Picker `selectionLimit` 1 → 10 (`MAX_PICKED_ASSETS`); pure `normalizePickedAssets` (unit-tested); 2+ picks open the new obsidian `MediaPreviewTray` (thumbnail strip, per-item remove, video badges, "Send N", a11y labels); single pick keeps the immediate-send fast path. N photos = N encrypted bubbles — zero protocol change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **MX-09**         | Composer never blocks: all media sends (library, camera, document, voice note) funnel through a SERIAL queue (one ≤50 MB plaintext buffer at a time) with a non-blocking "k of n" chip. `MediaClient.uploadEncrypted` gained an optional `onProgress` (XHR upload path; fetch path byte-identical when absent — existing tests pin it); `productionRuntime.sendMedia` publishes per-message progress into a `useSyncExternalStore` registry (`media/uploadProgress.ts`, 2% quantised) → determinate cobalt `UploadProgressRing` on the sending bubble / "Encrypting & uploading… NN%" on file rows. Cleared in `finally` so failed rows can't wear a stale ring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **MX-10**         | Thumb data-URI memoised per message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **MX-08**         | `src/utils/haptics.ts` semantic seam (tap/select/impact/heavy) replacing raw `Vibration.vibrate(ms)` at all ChatScreen + FileViewer call sites; documented upgrade path to a real haptics engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **MX-11/12**      | `scrollEventThrottle` 80 → 16; `renderItem` hoisted to `useCallback` (deps = exactly what it reads; `startReply`/`reactToMessage` memoised).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **B-86**          | New `vault/vaultOps.ts`: local biometric ceremony (expo-local-authentication; hardware-less devices fall through — the action token is the cryptographic gate) → `KeysHttpClient.mintActionToken('vault-access')` (`POST /auth/biometric/assert`, 401-refresh wired) → `VaultClient.uploadEncrypted` with single-use `X-Mfa-Proof` → REAL key material persisted (`VaultFile.sourceKey` added for dedup vs legacy rows). **Fail-closed preserved**: no proof → honest alert, zero writes; `vaultStore.addFile` refuses key-less rows (M-02 defense-in-depth); `vaultMoveGuard.test.ts` rewritten to lock the new invariant (14 tests incl. static source audits of FileViewer + vaultOps). Wired on all three surfaces: FileViewer "Move to Vault" (busy state "Securing…"), FilesScreen `pushToVault` (bytes via cached-blob decrypt or local pick), VaultScreen (direct uploads now real; **open** downloads + decrypts via a fresh proof per operation — proofs are single-use by design). Production note: builds without a real Play Integrity attestation keep vault moves disabled server-side (documented keysClient posture) — works on staging (`BIOMETRIC_DEV_BYPASS`). |

**Adversarial review pass (LOOP.md auditor step):** an independent reviewer combed the diff and
CONFIRMED 4 majors, all fixed same-session before ship: **M1** B-85 prop-only fix was a no-op
(nested `screen` param overrides initialRouteName → added `initial: false` at all 3 deep-link
sites + test lock); **M2** ZoomableImage double-tap was dead (pan BEGAN latched a flag on every
touch-down → flag now set only on ACTIVE, cleared on all terminal transitions, redundant
double-tap guard removed); **M3** the upload ring was unreachable (bubble media branches
required the post-upload object key → bubbles now classify by `msg.type` while
`uploadProgress` is live, transient no-key 'error' suppressed, runtime clears progress AFTER
the media patch to avoid a 1-frame text-branch flash); **M4** files opened FROM the vault
mismatched the index (`ViewableFile.vaultSourceKey` added; VaultScreen passes the row
objectKey — fixes duplicate re-uploads + silent no-op Delete). Minors fixed: stale queue
closure (ref-mirror + single readiness check), swipe re-swipe spring fight (stopAnimation on
BEGAN), timezone-fragile test fixtures (local-time strings). Reviewer-verified clean: inverted
ordering/anchoring/empty-state, media queue mechanics + XHR path, vault MFA chain (no key-less
row path, purpose allowlist, single-use proofs, no key logging), renderItem dep completeness.

**Verification:** tsc error signatures diffed vs clean main — identical 46 (only line shifts);
eslint 0 errors; messenger module + hooks + nav suites green (1274+ tests incl. 38 new);
full app+booking+crypto run: only known pre-existing failures. **Residual:** on-device verify
(Pixel 7a + BlueStacks matrix): notification-tap → chat → back lands on chat list; chat open
lands on newest with no flash; pagination at history top; swipe-reply vs scroll arbitration;
pinch/double-tap/pan feel; multi-pick tray → N ringed bubbles; vault move → biometric prompt →
row appears → open decrypts (staging). Watch item: `removeClippedSubviews` + inverted on
Fabric (blank cells on fast scroll ⇒ flip that prop).
