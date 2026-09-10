# Native-popup redesign (B-88) — branded Alert dialog · 2026-07-16

**Trigger (founder):** "some popup (native no design) — find all and make design."
**Status:** **FIXED same session** — audited, designed, swapped app-wide, gates green.

## 1 · Audit — what was native/undesigned

| Surface                                                                                       | Count                                                                                                                          | Verdict                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `Alert.alert` (RN → system AlertDialog: white card, Material buttons — clashes with obsidian) | **252 call sites / 71 files** (248 static imports + 4 lazy `require('react-native')` in `launchCall.ts` + `NewChatScreen.tsx`) | **THE finding — replaced**         |
| `Alert.prompt`                                                                                | 0 (one comment mention)                                                                                                        | n/a                                |
| `ToastAndroid` / `ActionSheetIOS`                                                             | 0                                                                                                                              | n/a                                |
| OS-owned chrome (permission dialogs, native pickers, share sheet)                             | —                                                                                                                              | out of scope by design (system UI) |

## 2 · Design — `BravoAlertHost` + `@utils/alert`

**Drop-in strategy:** `src/utils/alert.ts` exports an `Alert` object with the EXACT RN
`Alert.alert(title, message?, buttons?, options?)` signature, so all 252 call sites stayed
byte-identical — only their import line changed (`from 'react-native'` → `from '@utils/alert'`,
swapped by script + verified). A pure FIFO queue (node-testable, no RN imports) feeds
`src/components/BravoAlertHost.tsx`, mounted ONCE in `App.tsx` — a transparent RN `<Modal>`
that stacks above any other open Modal on Android, exactly where the native dialog floated.

**Visual (design-system locked, G8):** backdrop `rgba(4,6,10,0.72)`; centered card
`min(340, W-48)` on the `#131A28→#0C111B` sheet gradient, radius 22, hairline border; icon
medallion (cobalt `shield-alert-outline`; red `alert-circle-outline` when any button is
`destructive`); Manrope title 16/800 + dim message 13/19 (scrollable beyond 38% of screen
height); buttons ≥48dp: **one filled cobalt primary** (last default), outline-cobalt
secondaries, glass cancel (pinned left in 2-button rows), red-tinted destructive; 3+ buttons
stack vertically. All colour values are existing DM/FileViewer tokens — zero new palette.

**Semantics mirror RN Android** (call sites were written against them): no buttons → `OK`;
back/backdrop dismiss when `cancelable` (default true) fires `options.onDismiss` and never a
button handler; alerts issued while one is visible queue FIFO; queue advances BEFORE the
pressed handler runs so a handler that re-alerts chains cleanly; stale press ids ignored
(double-tap race); a throwing handler still closes the dialog. Bonus over native: alerts
fired before the UI mounts are queued, not dropped.

## 3 · DESIGN_REVIEW_LOOP iteration log

```
### Iteration 1 — global Alert dialog (all 252 call sites)
Findings:        [Major] every Alert.alert renders the SYSTEM dialog (white/Material) on obsidian → replace with branded host (root cause: RN Alert is native UI, unthemeable)
Fixes applied:   src/utils/alert.ts (queue+compat API) · src/components/BravoAlertHost.tsx (dialog) · App.tsx mount · 69 files import-swapped + 2 lazy-require files + 3 test files re-pointed
Self-critique:   320dp → card 272dp, 2-btn labels wrap (numberOfLines 2, minHeight grows) ✓ · fontScale 1.3 → text reflows, long messages scroll ✓ · landscape → 38%-height message cap ✓ · trap states → cancelable:false matches native, buttons always present (default OK) ✓ · a11y → role alert, labelled buttons/backdrop, contrast 15:1 title / ~9:1 body / >4.5:1 all button text ✓ · one-primary enforced in resolveAlertLayout ✓ · reduce-motion: fade only ✓ · perf: renders null when idle, useSyncExternalStore per transition ✓
Remaining risks: Modal-over-Modal ordering if ANOTHER modal opens while an alert is up (alert is last-presented → on top; rare inverse case device-verify) · iOS multiple-Modal quirk (iOS unshipped) · visual device pass pending
Scores:  UX 96 · A11y 96 · Responsive 96 · Perf 98 · Foldable 95 (centered card, no hinge-critical layout) · Prod-Ready 95
```

## 4 · Verification

- **Unit:** `src/utils/__tests__/alert.test.ts` (13 — queue, semantics, variants) +
  `src/components/__tests__/BravoAlertHost.test.tsx` (4 — render/press/queue) + **static
  sweep** locking that NO src file imports Alert from react-native (static or lazy) ever again.
- 3 pre-existing Alert-spying suites re-pointed to the shim (`BackupRestore.legacy`,
  `BackupSetup.audit`, `launchCallDoubleTap`) — green.
- tsc error signatures identical to HEAD (46, zero introduced) · eslint 0 errors on all 76
  touched files · full run 230 suites / 2018 tests — only the two known pre-existing failures.
- **Device-verify pending:** visual pass on Pixel 7a (fontScale 1.3, 320dp), alert-over-modal
  stacking (e.g. vault alerts inside FileViewer), back-button behavior on cancelable:false.
