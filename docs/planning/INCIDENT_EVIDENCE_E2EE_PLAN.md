# Incident Photo Evidence — E2EE build plan (Dept Chat v2 · Step 10 closure)

> **Goal.** Let an incident submitter attach an optional photo that **managers can view**,
> end-to-end-encrypted: the photo is AES-256-CBC encrypted before upload to Supabase/R2, and
> the per-file key is **sealed to each manager (and the submitter)** with the existing
> sealed-sender ECIES — the server never sees a plaintext key. Closes the gated Step-10
> follow-up surfaced by the 2026-06-25 completeness audit.

## Constraints (locked decisions)

1. **Reuse the crypto; do not reinvent it.** AES + upload via the existing `MediaClient`; key
   sealing via the existing `wrapOuter`/`unwrapOuter` (`outerEcies`); download via the runtime's
   existing `downloadMedia`; download-access via the existing `registerGrants`.
2. **Messenger module is touched ONLY by a minimal, additive seam** (approved): a few thin
   runtime methods that EXPOSE existing internals (`sealOuterTo`, `openOuterAsSelf`,
   `uploadEvidence`). **No existing chat/group/call path changes.** Everything else lives in the
   **deptchat** mobile screens and the **auth-service incident** module.
3. **Server never stores a plaintext key.** `incident_attachment_keys` stores only ECIES-sealed
   blobs (opaque ciphertext), one row per (attachment, recipient-device).
4. **Submitter is a CPO** (a channel viewer / non-member) — so delivery is NOT via a chat
   channel; the sealed key blobs are stored on the incident and fetched by the viewer.

## Crypto flow

```
SUBMIT (member device)
  bytes = read(photo)
  {objectKey, keyB64, ivB64} = MediaClient.uploadEncrypted(bytes, mime)     // ciphertext → R2/Supabase
  recipients = managers(org) + submitter            // each may have N devices
  for each recipient-device:
     blob = sealOuterTo(userId, deviceId, JSON{keyB64, ivB64, mime})        // wrapOuter → ECIES to that device identity
  POST /incidents/:id/attachments        { storage_key: objectKey }         // existing
  POST /incidents/:id/attachments/:att/keys { keys: [{recipient_user_id, device_id, sealed_key}] }   // NEW
  registerGrants(objectKey, [recipientUserIds])                             // existing (download access)

VIEW (manager or submitter device)
  att = GET /incidents/:id/attachments                                      // existing (storage_key)
  sealed = GET /incidents/:id/attachments/:att/key                          // NEW — caller's blob for THIS device
  {keyB64, ivB64} = openOuterAsSelf(sealed)                                 // unwrapOuter + verifySenderCert
  bytes = downloadMedia({objectKey, keyB64, ivB64})                         // existing (grant-checked)
  render <Image source={writeTempBytes(bytes)}>
```

## Reusable primitives (verified)

| Need             | Reuse                                                                                       | Location                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Encrypt+upload   | `MediaClient.uploadEncrypted(bytes, mime)` → `{objectKey,keyB64,ivB64,size}`                | `src/modules/messenger/media/mediaClient.ts:56` (exported via `media/index.ts`) |
| Download+decrypt | `runtime.downloadMedia({objectKey,keyB64,ivB64})` (already PUBLIC)                          | `productionRuntime.ts:1904`                                                     |
| Download access  | `MediaClient.registerGrants(objectKey, userIds)`                                            | `mediaClient.ts:218`                                                            |
| Seal to identity | `wrapOuter({recipientIdentityKeyB64, sender, ciphertext:{type,body}, cert})`                | `crypto/outerEcies.ts:175`                                                      |
| Open as self     | `unwrapOuter({ownIdentityPrivKey, ownIdentityPubKey, outerSealedB64})` + `verifySenderCert` | `crypto/outerEcies.ts:262`                                                      |
| Recipient id key | `recipientIdentityKeyB64Cached(ownStore, keys, peer, cache, ttl)`                           | `productionRuntime.ts`                                                          |
| Sender cert      | `certCache.get()`                                                                           | `productionRuntime.ts:451`                                                      |
| Org managers     | `resolveOrgManagers(orgUserId)` → `[org, ...active managers]`                               | `auth-service` incident service                                                 |

## Steps

### E1 — Runtime seal seam (messenger; minimal additive) — **verifiable here (tsc + unit test)**

- Add to `productionRuntime.ts` `runtimeApi` (and the `MessengerRuntime` interface + loopback stub):
  - `sealOuterTo(recipientUserId, recipientDeviceId, bodyJson) → Promise<string>` — `recipientIdentityKeyB64Cached` + `certCache.get()` + `wrapOuter`.
  - `openOuterAsSelf(outerSealedB64) → Promise<string>` — `ownStore.getIdentityKeyPair()` + `unwrapOuter` + `verifySenderCert`; returns the inner `body`.
  - `uploadEvidence(bytes, mime) → {objectKey,keyB64,ivB64,size}` — thin wrap of `getUploadMediaClient().uploadEncrypted` (so deptchat doesn't reconstruct media config).
  - `listRecipientDevices(userId) → Promise<number[]>` — thin wrap of the keys client device fetch (for per-device sealing).
- **No change to any existing method.** Unit test mirrors `__tests__/outerEcies.test.ts` (round-trip seal→open).

### E2 — Backend: sealed-key store (auth-service incident) — **verifiable here (specs)**

- Migration `<ts>_incident_attachment_keys.sql` (additive, RLS deny-by-default):
  `incident_attachment_keys(id, attachment_id→incident_attachments, recipient_user_id→users, device_id INT, sealed_key TEXT, created_at)`, unique (attachment_id, recipient_user_id, device_id).
- `incident.service.ts`: `storeAttachmentKeys(submitterId, incidentId, attachmentId, keys[])` (submitter-only, validates the attachment belongs to the submitter's incident); `getMyAttachmentKey(userId, deviceId, incidentId, attachmentId)` (submitter OR org-manager of the incident's org; cross-org 403); expose `resolveOrgManagers` (already exists) for the client to know recipients via `GET /incidents/:id/recipients`.
- `incident.controller.ts`: `POST /incidents/:id/attachments/:att/keys`, `GET /incidents/:id/attachments/:att/key`, `GET /incidents/:id/recipients`.
- 🛑 `org_audit_log`/logs carry NO key bytes, NO coordinates, NO description.

### E3 — Mobile submit (deptchat) — **device-test required**

- `ReportIncidentDetailsScreen`: replace the disabled placeholder with a real "Add photo" (`react-native-image-picker` `launchCamera`/`launchImageLibrary`, gallery permission per PDF p.12 + the "only capture where safe/lawful" notice). Hold the picked asset in state; upload on submit.
- After `incidentApi.submit` → `id`: `rt.uploadEvidence(bytes, mime)`; resolve recipients (`GET recipients`) + their devices (`rt.listRecipientDevices`); `rt.sealOuterTo` per recipient-device; `incidentApi.attach(id, objectKey)`; `POST keys`; `rt.grantEvidenceAccess(objectKey, recipientUserIds)` (or reuse the registerGrants path).

### E4 — Mobile view (deptchat) — **device-test required**

- `IncidentDetailScreen` (manager) + `MyIncidentDetailScreen` (submitter): an "Evidence" section → `listAttachments` → for each, `GET key` (this device) → `rt.openOuterAsSelf` → `rt.downloadMedia` → `writeTempBytes` → `<Image>`. Graceful states: no key for this device (rotated/added after submit), download denied, decrypt fail.

### E5 — Multi-device + rotation — **device-test required**

- Seal to ALL of each recipient's devices at submit. If a manager adds/rotates a device AFTER submit, they won't have a blob for it → show "evidence sealed before this device existed; open on your original device" (no silent failure). (A re-seal-on-demand path is a later refinement.)

### E6 — Tests & gates

- E1: mobile `npm run test:crypto` (untouched) + a new runtime seam unit test; mobile tsc ≤ baseline.
- E2: `cd apps/auth-service && npm test` (new incident-key specs: store submitter-only, fetch submitter|manager, cross-org 403, no key in audit).
- E3/E4/E5: device matrix (submit with photo on a CPO device; manager views; multi-device).
- Adversarial review of the diff before commit.

## Security stop-conditions 🛑

- Server stores ONLY sealed (ECIES) blobs — never a plaintext key/iv. The seal binds the sender cert (v3 AAD); the viewer `verifySenderCert` before trusting.
- Reuse the existing media encrypt/upload/download/grant + the existing `wrapOuter`/`unwrapOuter` verbatim — no new crypto, no change to existing messenger paths.
- Photo is always optional; a report submits fine without one. No key/coords/description in any log or `org_audit_log`.
- File-Vault MFA is unrelated here (incident evidence is its own restricted-access object), but the encrypted-media discipline (encrypt-before-upload, opaque object key, grant-gated download) is preserved.

## Status

- [x] **E1 runtime seam** (2026-06-25) — `sealOuterTo`/`openOuterAsSelf`/`uploadEvidence`/`grantMediaAccess` added to `productionRuntime` `runtimeApi` + optional sigs on the `MessengerRuntime` interface (loopback unaffected — optional). Reuses `wrapOuter`/`unwrapOuter` + `getUploadMediaClient` + `mediaClient.registerGrants` + `certCache` verbatim; no existing path changed. tsc 47 ≤ baseline, lint clean. Dead until E3/E4 wire it.
- [x] **E2 backend** (2026-06-25) — migration `20260629000004_incident_attachment_keys.sql` (additive, RLS deny-by-default, one sealed blob per attachment/recipient/device) + `IncidentService.evidenceRecipients` / `storeAttachmentKeys` (uploader-only, idempotent upsert) / `getMyAttachmentKey` (submitter|org-manager, 404 if no blob for this device, cross-org 403) + controller routes `GET :id/recipients`, `POST :id/attachments/:att/keys`, `GET :id/attachments/:att/key` + DTO `StoreAttachmentKeysDto`. Server stores opaque sealed blobs only. **29 incident specs pass**; auth-service tsc clean. ⚠️ migration not yet applied to Supabase (apply via MCP/db push before live use).
- [x] **E3 submit** (2026-06-25) — `ReportIncidentDetailsScreen` photo picker (`react-native-image-picker`, base64, capped 1600px, "safe & lawful" prompt) + on-submit `uploadAndSealEvidence` (best-effort; never blocks the report). NEW `incidentEvidence.ts` helper: `uploadEvidence` → `evidenceRecipients` → `attach` → `sealOuterTo` per recipient → `storeAttachmentKeys` → `grantMediaAccess`. + 3 `incidentApi` methods.
- [x] **E4 view** (2026-06-25) — NEW `EvidenceSection.tsx` in the manager `IncidentDetailScreen` + submitter `MyIncidentDetailScreen`: `listAttachments` → tap → `getAttachmentKey(device)` → `openOuterAsSelf` → `downloadMedia` → `writeTempBytes` → `<Image>`. Degrades to "can't open on this device" on a missing blob / decrypt fail.
- [x] **E5 (partial)** — v1 seals to / fetches from the **primary device (id 1, Signal default)**; `loadEvidenceUri` returns null (graceful) for a non-primary device. Real multi-device fan-out (seal to every device via a device-list endpoint) remains a follow-up.
- [ ] **E6 device proof** — gates GREEN (mobile tsc 47 ≤ baseline, lint clean, app Jest 132, 29 incident specs). STILL REQUIRED on a real device: camera→encrypt→upload→seal→store→fetch→unseal→download→render round-trip; a second (manager) device decrypting; and **applying the migration to Supabase**.

## Device test #1 — 2026-06-25 (findings + fixes)

Tester submitted INC-2026-00001 as a CPO and viewed it as the service/manager. **No photo appeared** and **location showed raw coords** ("Current location · 23.6801, 90.5240").

Root cause (verified against live Supabase): `incident_attachments` and `incident_attachment_keys` are **EMPTY** for the only incident — `att_count=0`. The photo was **never uploaded**: `uploadAndSealEvidence` reached `rt.uploadEvidence()` (or `evidenceRuntime()` returned null) and failed **before** `attach()` ran, and **both** the per-recipient `catch{}` and the screen-level `catch{}` swallowed it, so the submitter saw a success screen with zero evidence. Earlier the photo capture also "refreshed" the app — a multi-MB base64 held in screen state (`includeBase64:true`) got the host activity reclaimed under memory pressure on the low-RAM device, wiping the in-progress report.

NOTE on device-id: the `auth_devices.signal_device_id` counter (manager=6, submitter=2 after reinstalls) is the **auth-layer** reinstall counter, NOT the Signal **protocol** device id. The messenger addresses every peer as `deviceId:1` (chat works on that basis), and `signal_identities.device_id=1` is the live published identity. So `EVIDENCE_DEVICE_ID=1` is **consistent with working chat** — it is NOT the cause here (att_count=0 means the upload failed before any seal). Left unchanged (changing it would risk the seal + violate the messenger no-touch constraint).

Fixes (deptchat-only; no messenger crypto/seam change):

- **Capture by uri, not base64** — `ReportIncidentDetailsScreen.runPicker` drops `includeBase64`; bytes are read only at upload via the existing `readUriBytes` seam. Removes the memory-pressure refresh.
- **Visible failure** — `uploadAndSealEvidence` never throws; it returns `EvidenceResult{attached, sealedFor, reason}`. The submit screen shows an Alert ("…photo could not be uploaded / secured…") instead of a silent success, then still navigates (report itself succeeded).
- **Diagnostics** — non-secret `[bravo.incident-evidence]` breadcrumbs (step + counts + error name/status only — never key/iv/body/coords) so the next device test pinpoints runtime-null vs upload-HTTP-error (the prime suspect is media storage not presigning — "S3 keys pending").
- **Readable location** — new `geo.reverseGeocode(lat,lng)` (Mapbox, `EXPO_PUBLIC_MAPBOX_TOKEN`); `captureLocation` stores the address as `location_label` (falls back to a coarse label on a miss). Both detail screens already render `location_label`.
