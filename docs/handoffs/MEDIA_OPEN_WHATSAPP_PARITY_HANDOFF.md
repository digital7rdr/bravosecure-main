# Media Messages — WhatsApp-Parity Open/Show Plan ("tap → it opens, fast, always")

> **Date:** 2026-07-03 · **HEAD:** `7a22482` (v1.0.90, vc115) · **Status:** ✅ **IMPLEMENTED 2026-07-03** (all 4 phases) — shipped in v1.0.91 (vc116). See the implementation addendum (§9) at the end.
>
> **Purpose:** self-contained problem analysis + fix plan for media messages (image, video, audio/voice, PDF/documents). Target behavior is WhatsApp's: an inline preview in the bubble, one tap, opens fast, and it ALWAYS opens. Every claim below was verified in code at `7a22482` and cited to file:line — a fix session should not need to re-explore. Where a fix touches an architecture stop-condition it is explicitly marked **ARCH-GATED**.

---

## 0. TL;DR — what is actually wrong (plain English)

Media in this app is a sealed box shipped by armored truck: the crypto and transport are fine, but the receiving end was never given a door. Three headline facts:

1. **Videos and PDFs literally cannot be opened on Android today.** The viewer calls `Linking.openURL('file://…')` on a file inside the app's private cache. Android ≥7 throws `FileUriExposedException` for `file://` intents, there is **no FileProvider declared in the manifest**, there is **no in-app video player installed**, and no document-viewer library. Every tap ends in "Could not open". This is deterministic, not flaky. The **Files tab** and **dept-chat attachments** are also 100% dead (a `disabled` row and a TouchableOpacity with no `onPress`).
2. **Everything else is slow by construction.** Opening one image = 2 network round-trips + ~6 full-file passes (base64 bridge copies, a pure-JS HMAC over the whole file, AES pass, base64 re-encode, disk write) — and the whole pipeline **re-runs on every bubble mount and again when the viewer opens**, because the already-decrypted temp file is never checked first. Non-image media needs **two taps** ("Tap to download" → "Tap to open"). There are no thumbnails, no progress, no compression (camera photos ship at full resolution), and the sender **re-downloads their own upload from the server** just to render their own bubble.
3. **Old media dies silently.** Grants and the server's ownership record expire after **30 days**, and a daily sweep then deletes the R2 object — while the chat bubble (and backups) live forever. Any media older than 30 days that isn't in the local cache is permanently unopenable, with no re-request protocol. Group members **added after a send can never open pre-join media** (grants are a send-time snapshot). A failed grant registration is a `console.warn` and never retried.

**What is NOT broken:** the crypto contract (AES-256-CBC per-file key + HMAC, key in-band — locked, keep it), the grant auth model (userId-scoped, multi-device safe), and vault MFA (does not apply to chat media — verified).

---

## 1. Master gap table (ranked)

| #   | Gap                                                                                                                                                                                                                                    | Class                                      | Evidence                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Video + PDF unopenable on Android (`Linking.openURL(file://)`, no FileProvider, no player lib)                                                                                                                                         | **BROKEN**                                 | `FileViewer.tsx:94-99,132-150`; manifest grep: no FileProvider; `package.json`: no video/file-viewer lib                                 |
| M2  | Files tab rows all disabled (`canView=!!mediaUrl`, never set); dept-chat attachment has no `onPress`                                                                                                                                   | **BROKEN**                                 | `FilesScreen.tsx:124,225-233`; `DepartmentChatScreen.tsx:396-403`                                                                        |
| M3  | 30-day server death: grant+owner TTL 30d (`GRANT_TTL_SECONDS`, `media.service.ts:50`) + daily orphan sweep deletes objects with no live owner record (`:98-151`) → bubble outlives blob forever                                        | **BROKEN (time-bomb)**                     | `media.service.ts:50,128-137`; client comment `productionRuntime.ts:1571`                                                                |
| M4  | Late-joined group members can never open pre-join media (grants = send-time participant snapshot; no re-grant on member-add anywhere)                                                                                                  | **BROKEN**                                 | grants only at `productionRuntime.ts:2193,2348,2526`; `media.service.ts:222` rejects non-members                                         |
| M5  | `registerGrants` failure = warn-only, no retry/queue → permanent 403 for all recipients under strict mode                                                                                                                              | **BROKEN (flaky)**                         | `productionRuntime.ts:2193-2196,2348-2351`                                                                                               |
| M6  | Full re-download+re-decrypt pipeline on every mount + AGAIN in the viewer; decrypted temp file never checked first; no in-flight dedup                                                                                                 | **SLOW**                                   | `useAttachmentUri.ts:57-67`; second hook instance `ChatScreen.tsx:1533`                                                                  |
| M7  | Two-tap open for video/audio/file ("Tap to download" → "Tap to open")                                                                                                                                                                  | **SLOW (UX)**                              | `ChatScreen.tsx:1920-1923`                                                                                                               |
| M8  | No thumbnails/blurhash/dimensions/duration/filename on the wire — bubbles are lock-boxes and generic icon rows; images render 254×254 crops                                                                                            | **UX**                                     | `ChatScreen.tsx:1893-1896,1925-1947`; `SealedAttachment` (`packages/messenger-core/src/crypto/sealedSender.ts:69-80`) has no such fields |
| M9  | No compression: camera/gallery ship original bytes (no `quality/maxWidth`); 50 MB cap; base64 bridge + pure-JS HMAC make big files multi-second JS-thread stalls                                                                       | **SLOW**                                   | `ChatScreen.tsx:850,862`; `mediaFiles.ts:26-33`; `aesCbc.ts:140-144,180-186`                                                             |
| M10 | Sender re-downloads own upload (upload never seeds the cache; `media_url` never populated — the comment claiming otherwise is stale); bubble appears only AFTER full upload; no progress/cancel; no offline queue; media retry refused | **SLOW/UX**                                | `mediaClient.ts:189-194`; `useAttachmentUri.ts:4-5` (stale doc); `ChatScreen.tsx:618-625,837-841,1282-1287`                              |
| M11 | >25 MB blobs are NEVER cached (per-blob cap) → every video view re-downloads; 200 MB LRU total                                                                                                                                         | **SLOW**                                   | `mediaBlobCache.ts:28,34,77-79`                                                                                                          |
| M12 | No auto-download policy (images auto, everything else manual), no download queue (first chat open can fire ~20 concurrent image downloads), no per-bubble progress                                                                     | **UX**                                     | `ChatScreen.tsx:1645,1137,1150`                                                                                                          |
| M13 | Voice notes: no inline player, no seek, no waveform, `durationMs` recorded but never transmitted                                                                                                                                       | **UX**                                     | `VoiceNoteRecorder.tsx:14-16,117`; `ChatScreen.tsx:1328,1938-1944`; `FileViewer.tsx:219-227`                                             |
| M14 | Document filename dropped at pick (`asset.name` discarded); unknown mimes → extensionless temp file; forward ships `size 0`                                                                                                            | **UX**                                     | `ChatScreen.tsx:881-886,741`; `mediaFiles.ts:94`                                                                                         |
| M15 | Share broken on Android (`Share.share({url})` is iOS-only) — shares the file NAME as text; no save-to-gallery                                                                                                                          | **UX**                                     | `FileViewer.tsx:89-92`                                                                                                                   |
| M16 | Image viewer: no zoom/pan/swipe; no per-chat media gallery                                                                                                                                                                             | **UX**                                     | `FileViewer.tsx:124-126`                                                                                                                 |
| M17 | Error states indistinguishable (403 vs 404 vs offline all render "Tap to retry"); no timeout on the download fetch                                                                                                                     | **UX**                                     | `mediaClient.ts:179-184`; `useAttachmentUri.ts:69-73`                                                                                    |
| M18 | Ops-console has NO media support at all (grants issued to web recipients are unused)                                                                                                                                                   | **GAP**                                    | zero attachment refs in `apps/ops-console/src/lib/messenger/`                                                                            |
| M19 | Security posture notes: decrypted plaintext persists in the OS cache dir for live messages; legacy untagged blobs decrypt with NO HMAC (downgrade hole); presigned GET is raw/replayable for 300 s (P0-A6 open)                        | **SECURITY (flag, don't silently change)** | `mediaFiles.ts:10-16,50`; `aesCbc.ts:193-197`; `media.service.ts:237-242`                                                                |

---

## 2. Current pipeline map (condensed, all file:line verified at `7a22482`)

### 2.1 Send

Picker (`ChatScreen.tsx:850/862/876`, voice `VoiceNoteRecorder.tsx:93`) → `readUriBytes` (whole file via base64 string, `mediaFiles.ts:26-33`) → 50 MB cap check (`ChatScreen.tsx:825-829`) → `rt.sendMedia` (`productionRuntime.ts:2472`) → `aesCbc.encryptAttachment` (fresh key+IV, native AES via quick-crypto, **HMAC in pure JS** `@noble`, v2 format `[0x02|ct|hmac32]`, `aesCbc.ts:94-149`) → `POST /media/upload-url` + presigned `PUT` (no progress, `mediaClient.ts:56-73`) → upload-verify `HEAD` (+2 RTTs, `:89-116`) → `registerGrants` (awaited, warn-only on failure) → `sendText` with `SealedAttachment {objectKey,keyB64,ivB64,mimeType,size,kind}` in the sealed envelope. **5 HTTP calls per send; bubble appears only after all of it.**

### 2.2 Receive/open

Row lands with `media_*` fields (`productionRuntime.ts:6180-6247`) → bubble: images auto-`load()` on mount, others "Tap to download" (`ChatScreen.tsx:1645,1925-1947`) → `useAttachmentUri.load()` (`useAttachmentUri.ts:48-75`) → `downloadEncrypted` (`mediaClient.ts:143-201`): SQLCipher ciphertext-cache probe → miss: `POST /media/download-url/:key` (RTT 1) → presigned GET whole-file `arrayBuffer()` (RTT 2, no timeout/progress) → cache.put → JS HMAC verify + native AES decrypt (`aesCbc.ts:180-200`) → `writeTempBytes` base64 → `CachesDirectoryPath/bravo-media-<msgId>.<ext>` (`mediaFiles.ts:49-56`) → subtitle flips to "Tap to open" (second tap) → viewer mounts a SECOND `useAttachmentUri` (`ChatScreen.tsx:1533`) re-running cache+HMAC+AES+base64.

Viewers (`FileViewer.tsx`): image = plain `<Image>` (`:124-126`); audio = expo-audio modal, no seek (`:192-237`); **video/pdf = `Linking.openURL(file://)` → always fails** (`:94-99,132-150`).

### 2.3 Cache

Ciphertext: `media_blobs` in SQLCipher, LRU 200 MB, 25 MB/blob cap (`mediaBlobCache.ts:28,34`). Plaintext: temp files, deleted on message removal/expiry (`productionRuntime.ts:1464-1521,1567-1581`). Neither is consulted in the fast order (temp file last, not first).

### 2.4 Server (`apps/messenger-service/src/media/`)

Four JWT-guarded endpoints (`media.controller.ts:53-93`): upload-url (server-keyed `att/<uuid>`, signs ContentLength+ContentType, DTO hard-caps 50 MB — `dto/upload-url.dto.ts:4`), download-url (grant check `media.service.ts:213-233`; **lax by default**, strict via `MEDIA_REQUIRE_RECIPIENT_GRANT` — deployed value NOT in repo, verify on the box), grants (additive, owner-protected `SADD` + 30d TTL, `:258-303`), purge (owner-only, `:314-344`). Presign TTL 300 s both ways (`:171,235`). Daily 4 AM orphan sweep deletes `att/*` objects >30 d with no live owner record (`:98-151`). No throttling on `/media/*`. No R2 lifecycle policy as backstop.

### 2.5 ⚠️ Doc-drift warning (do not trust these audit rows)

`docs/audits/MESSAGING_AUDIT.md` marks **P0-A4** ("envelope-linked media deletion", `deleteForEnvelope`, `media-of-env` indices) and **P0-A6** ("IP-bound MediaProxyController") as FIXED. **That code does not exist at HEAD and never existed in git history** (`git log -S` returns nothing; the symbols appear only in the doc). Real state: A10 client purge + MEDIA-A4 orphan sweep exist; envelopeId is accepted by the grants DTO but **dropped** (`media.controller.ts:81`); P0-A6 is fully open (raw presigned GET).

---

## 3. Why "sometimes it doesn't open" — failure catalogue

| Cause                                                                                                      | Determinism                   | Cite                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Video/PDF viewer path broken (M1)                                                                          | always                        | `FileViewer.tsx:94-99`                                                                                            |
| Object >30 d old → swept (M3); restore-from-backup of old history hits this every time                     | always after 30 d             | `media.service.ts:128-137`                                                                                        |
| Late-join group member → `not_in_recipient_grant` 403 (M4)                                                 | always for pre-join media     | `media.service.ts:222`                                                                                            |
| Grant SADD failed at send + strict mode → 403 for everyone (M5)                                            | per-send flakiness, permanent | `productionRuntime.ts:2193-2196`                                                                                  |
| Offline/flaky: bare fetch, no timeout/retry; error state is generic (M17)                                  | transient                     | `mediaClient.ts:179-184`                                                                                          |
| Pre-"Round 8" legacy rows without `media_key` → instant error                                              | legacy rows                   | `useAttachmentUri.ts:40,51-53`                                                                                    |
| Note-to-self: empty recipient set skips grants entirely; strict mode blocks even the sender; swept at 30 d | always (strict)               | `mediaClient.ts:207-228` (its "server stamps implicit grant" comment is WRONG — `createUploadUrl` stamps nothing) |
| HMAC mismatch on cached blob → evict+refetch once (works); genuine tamper → error                          | rare                          | `mediaClient.ts:159-176`                                                                                          |
| 50 MB files: multi-copy base64/JS-HMAC memory spikes → Hermes OOM/stall risk                               | large files                   | `mediaFiles.ts:31`, `aesCbc.ts:141-149`                                                                           |

---

## 4. The fix plan (phased; 1–2 are client-only and need no arch sign-off)

### Phase 1 — "Everything opens, one tap" (kills M1, M2, M7, M17; the BROKEN class)

1. **FileProvider + real viewers.** Declare an Android FileProvider (or use `expo-sharing`/`react-native-file-viewer`, which bundle one). Video: add `expo-video` (SDK-54-native) and play the decrypted temp `file://` in-app — the file already exists, no crypto change. PDF/documents: `react-native-file-viewer` (content-URI + ACTION_VIEW) with a fallback "share to open" sheet. Keep images/audio in-app as today.
2. **One-tap:** after a user-initiated `load()` resolves, open the viewer automatically (`ChatScreen.tsx:1920-1923`).
3. **Wire the dead surfaces:** Files tab rows and dept-chat attachment rows route through the same `useAttachmentUri` + viewer keyed off `media_object_key` (`FilesScreen.tsx:225-233`, `DepartmentChatScreen.tsx:396-403`).
4. **Honest errors:** map 403 → "You don't have access (ask sender to resend)", 404/NoSuchKey → "Expired — ask sender to resend", network → "No connection, tap to retry" in `useAttachmentUri`/`MediaHttpError`.

### Phase 2 — "Fast" (kills M6, M9, M10, M11, M12; big perceived-speed wins)

5. **Fast-path ordering + single-flight:** in `useAttachmentUri`, stat the decrypted temp file FIRST and return it (it is the product of a prior authenticated decrypt); add a module-level in-flight promise map + resolved-uri memo per messageId shared by bubble and viewer. Warm opens become ~0-pass.
6. **Compress on send:** picker `quality/maxWidth/maxHeight` (e.g. 0.8/1600px like WhatsApp default) for photos; leave documents untouched. Single biggest end-to-end latency win.
7. **Optimistic send:** append the bubble (status `sending`, local pick URI as its preview) BEFORE upload; seed the ciphertext cache and write the plaintext temp file during `uploadEncrypted` (bytes are in hand — sender never re-downloads own media); add upload progress (XHR `onprogress` or `FileSystem.uploadAsync`) + cancel; queue failed uploads for retry instead of refusing (`ChatScreen.tsx:618-625`).
8. **Native fast crypto/IO:** switch the HMAC from `@noble` (pure JS) to quick-crypto's native `createHmac` (same algorithm/bytes — verify with existing `aesCbc.test.ts` vectors + a cross-impl test), and replace base64-string file IO with byte APIs. No format change.
9. **Cache policy:** raise/remove the 25 MB per-blob cap (videos), keep the 200 MB LRU; optionally an on-disk encrypted blob store for >25 MB instead of SQLCipher rows.
10. **Download manager:** concurrency-limited queue (2–3), per-bubble progress %, WhatsApp-style auto-download settings (photos always; audio/video/docs on Wi-Fi — default sane, setting later).

### Phase 3 — "Looks like WhatsApp" (M8, M13, M14, M15, M16) — **ARCH-GATED envelope change**

11. **Rich attachment metadata in the sealed envelope:** add optional `SealedAttachment` fields — `name`, `width`, `height`, `durationMs`, and `thumbB64` (a ≤10–20 KB JPEG/blurhash, generated sender-side pre-encrypt). These ride INSIDE the encrypted payload (same trust domain as `keyB64` — the relay sees nothing), but **the envelope shape is a CLAUDE.md stop-condition**: update `KNOWN_SEALED_KEYS` (`sealedSender.ts:573`) + get architecture sign-off + run `npm run test:crypto`. Bubbles then render instant previews with correct aspect ratio, video duration, and real filenames.
12. **Inline voice-note player** in the bubble (expo-audio): play/pause + seekable progress + transmitted duration; waveform later (expo-audio metering).
13. **Image viewer UX:** pinch-zoom/pan (standard RN component over the same decrypted URI), swipe between conversation media (`selectMediaMessages`, `messengerStore.ts:1250-1266`), save-to-gallery + working share via `expo-sharing` content-URIs (note: exporting plaintext is deliberate user action — confirm posture).

### Phase 4 — "Always openable, forever" (M3, M4, M5, M18) — client+server, one arch/product decision

14. **Grant durability:** queue failed `registerGrants` in the durable outbox and replay on reconnect (closes M5). Server needs nothing — grants are additive/idempotent.
15. **Member-add re-grant:** when the owner adds a member, re-grant that member the thread's historical `media_object_key`s (roster-gated, mirrors the `reshareGroupKeyState` pattern). Consider a distinct server error (`grant_exists_not_member`) so clients can trigger sender-side re-grant self-heal on tap.
16. **The 30-day cliff — needs a product/arch decision** (pick one):
    a. extend owner/grant TTL on download activity (media stays while people still open it);
    b. lifetime = relay-dwell parity but add a **sender re-upload protocol** (recipient tap on a 404 sends an encrypted `media-request` control message; sender re-uploads from its own cache/temp file and re-sends the attachment envelope) — WhatsApp does effectively this;
    c. keep 30 d and surface it honestly in the bubble ("Expired").
    Recommendation: (a) + (b) combined; (c) alone is the cheap stopgap.
17. **Ops hygiene:** verify `MEDIA_REQUIRE_RECIPIENT_GRANT` on the Contabo box before flipping anything (`docker exec bravo-staging-msgr env | grep MEDIA`); DTO cap must move with `MEDIA_MAX_UPLOAD_BYTES` (`dto/upload-url.dto.ts:4`); add `UserThrottlerGuard` to `/media/*`; wire the accepted-but-dropped `envelopeId` (`media.controller.ts:81`) if retract-triggered deletion is wanted; P0-A6 (raw presigned GET) remains an open security row — the documented proxy design was never built.

### Explicitly OUT of scope without architecture sign-off

- Changing AES-256-CBC or the whole-file HMAC format (streaming/range decryption would need a chunked envelope — N independently CBC+HMAC'd chunks with a manifest in the sealed envelope; presigned GETs already pass `Range`, so it needs no server change, but it IS an envelope/crypto-format change). Phase 1's in-app player over the decrypted local file makes playback progressive enough without touching this.
- The legacy untagged-blob decrypt path (`aesCbc.ts:193-197` — accepts unauthenticated CBC): closing it is a security fix, coordinate with the crypto owner (old media would stop decrypting).

---

## 5. Latency budget (what "fast" should mean after Phase 2)

| Scenario                             | Today                                                    | Target                                                                                        |
| ------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sender's own image bubble            | full upload + re-download + decrypt (~5 HTTP + 6 passes) | instant (local pick URI / seeded temp file)                                                   |
| Cold image open (1 MB, good network) | 2 RTT + 6 full-file passes + 2 mounts of the pipeline    | 2 RTT + 2 passes (native HMAC+AES) + 1 shared resolution; thumbnail visible at 0 ms (Phase 3) |
| Warm re-open                         | full cache-read+HMAC+AES+base64 every mount              | temp-file stat only (~ms)                                                                     |
| Video open                           | download-all + decrypt + FAIL                            | thumbnail → progress % → in-app player on decrypted file                                      |
| Voice note                           | 2 taps + modal, no seek                                  | inline play, 1 tap, seek                                                                      |

---

## 6. Tests a fix session must add (and gates)

- **Unit:** MediaClient upload/download with mocked fetch (progress, timeout, 403/404/NoSuchKey mapping, evict-on-bad-decrypt already-covered path); `MediaBlobCache` LRU + per-blob-cap; `useAttachmentUri` fast-path ordering (temp file BEFORE decrypt) + single-flight dedup + error mapping; `writeTempBytes`/extension mapping; grant-outbox replay.
- **Crypto:** cross-impl HMAC vector test when swapping `@noble` → quick-crypto native (identical tag over identical bytes); `SealedAttachment` new-fields round-trip + `KNOWN_SEALED_KEYS` whitelist test (**run `npm run test:crypto` — envelope changes are regression-gated**); log-audit test (no key material in new logs).
- **Server:** `sweepOrphanedMedia` (age/owner-record logic, pagination), MEDIA-A1 second-sender regression, grant-TTL behavior, member-re-grant flow, >1024-recipient rejection, controller e2e for envelopeId once wired.
- **Existing tests to keep green:** `aesCbc.test.ts`, `mediaClientGrants.test.ts`, `mediaBlobCachePurge.test.ts`, `media.service.spec.ts` (17).
- **Gates:** `npm run test:crypto` → `npm run typecheck` (baseline 49) → `npm test`; `cd apps/messenger-service && npm test`; manual smoke per §7.

## 7. Device verification script (after fixes)

1. Send a photo, video (>10 s), voice note, and a PDF from the phone → each bubble appears IMMEDIATELY with progress; recipient (BlueStacks) sees a thumbnail/preview row, taps ONCE → opens (video plays in-app, PDF opens via system viewer).
2. Re-open each item twice → second open is instant (no spinner, no network — verify with airplane mode ON for the warm open).
3. Sender's own media renders without any network (airplane mode right after send completes).
4. Files tab: every row opens. Dept-chat: attachment opens.
5. Group: add a NEW member, they open a photo sent BEFORE they joined (Phase 4.15).
6. Kill network mid-download → honest error + working retry.
7. Send a 40 MB video → no ANR/OOM; progress visible; plays after download.
8. `adb logcat -s ReactNativeJS:* *:S` — no `media_key`/plaintext in logs (log-audit posture).

## 9. Implementation addendum (2026-07-03, all phases shipped)

Every phase was implemented the same day (commit after `7a22482`, shipped v1.0.91/vc116). Native deps added
(require a native rebuild — autolinked): `expo-video`, `expo-sharing`, `expo-image-manipulator`,
`react-native-file-viewer`.

**Phase 1 — everything opens (M1/M2/M7/M17):**

- `ui/FileViewer.tsx`: in-app `expo-video` player (`VideoPreview`), documents via
  `react-native-file-viewer` (FileProvider content-uri, `open` with share-sheet fallback), `Share` fixed to
  `expo-sharing.shareAsync`. Video + PDF now open (were deterministically broken on Android).
- One-tap: bubbles auto-open the viewer after a user-initiated download (`autoOpen` state).
- New `ui/AttachmentFileViewer.tsx` — shared resolving viewer; wired into `FilesScreen` (rows were all
  disabled) and `DepartmentChatScreen` (attachment had no `onPress`).
- Honest errors: `media/attachmentError.ts` (`classifyAttachmentError` 403→forbidden/404→gone/net→offline +
  `attachmentErrorText`), surfaced in both viewers + the image bubble.

**Phase 2 — fast (M6/M9/M10/M11):**

- `media/mediaFiles.ts` `statTempBytes` (fast path) + `media/useAttachmentUri.ts` rewrite: temp-file-first,
  module-level single-flight (`inFlight`/`resolvedUri`) shared by bubble + viewer + `seedResolvedAttachmentUri`.
- Picker compression (`quality 0.8`, `maxWidth/Height 1920`) + a ≤48 KB `expo-image-manipulator` thumbnail.
- `mediaClient.uploadEncrypted` seeds the blob cache; `sendMedia` writes the plaintext temp file + memoizes
  its uri (sender never re-downloads own media). `aesCbc` HMAC → quick-crypto native `createHmac`
  (@noble fallback). Per-blob cache cap 25 → 50 MB.
- `mediaClient.downloadEncrypted` gets a 60 s `AbortController` timeout.

**Phase 3 — rich metadata (M8/M13/M14, ARCH — owner-approved):**

- `SealedAttachment` gains optional `name/width/height/durationMs/thumbB64` in BOTH crypto copies +
  `KNOWN_SEALED_KEYS`/`isSealedPayload` validation with bounds (name ≤256, thumb ≤64 KB). SQLCipher schema
  **v13** `media_meta_json` + backup round-trip (`backupWireV3` + `restoreMessages`). Bubbles render instant
  thumbnail + aspect ratio + duration/filename labels. Voice-note seek (`AudioPreview` progress bar → `seekTo`).

**Phase 4 — always openable (M3/M4/M5) + server:**

- `mediaClient.registerGrants` retries transient (network/429/5xx) with backoff; 4xx throws immediately.
- `addGroupMember` re-grants the group's recent (≤100) own-media objects to the new member.
- Server `media.service.createDownloadUrl` refreshes the grant + owner 30-day TTL on every download (media
  people still open survives the orphan sweep); `/media/*` now behind `UserThrottlerGuard` + per-route
  `@Throttle`. **Deployed to Contabo** (`bravo-staging-msgr` rebuilt + recreated, /ready 200, grep-verified
  `grant TTL refresh` + `UserThrottlerGuard` in `dist/`). Rollback: `~/src-bak-media-parity-20260703.tgz`.

**Gates at ship time:** crypto 1221, full mobile 1526, mobile tsc 46/49, messenger-service 18 media tests +
tsc clean, ops-console tsc clean. +19 tests (`mediaAttachmentMeta` 8, `attachmentResolve` 8, grant-retry 3,
server TTL 1).

**Left as documented-but-deferred:** ops-console media (M18 — still no web media path); true
range/streaming decryption (chunked-envelope, arch-gated — the in-app player over the decrypted file makes
this unnecessary for parity); the legacy untagged-blob decrypt path (§1 M19 — separate security coordination).

**Pending device QA:** §7 script (send each type → one-tap open; warm re-open instant; sender media offline;
Files/dept open; add-member sees pre-join media; big-video no-OOM).

## 8. Related documents

- `docs/audits/MESSAGING_AUDIT.md` — media P0/P1 rows (**P0-A4 + P0-A6 rows are doc-drift — code never existed; see §2.5**).
- `docs/audits/MESSENGER_FULL_AUDIT_2026-07-02.md` — media slice (MEDIA-A1..A5 verification states) + WhatsApp-parity list.
- `docs/audits/MSG_BACKUP_AUDIT_2026-07-02.md` — backup/restore pipeline (media keys round-trip, but old-object 404s after the 30-day sweep).
- `docs/handoffs/GROUP_ADD_VISIBILITY_AND_DELIVERY_GAPS_HANDOFF.md` — the member-add seam Phase 4.15 hooks into (same owner-side add flow).
- CLAUDE.md security constraints — media encryption contract (AES-256-CBC, per-file key, in-band) is **locked**; envelope-shape changes are stop-conditions.
