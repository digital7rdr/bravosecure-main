/**
 * Incident photo evidence (Dept Chat v2 · Step 10 · E3/E4) — client orchestration
 * that REUSES the runtime seal seam (E1) + the incident key store (E2). No crypto
 * is implemented here; we only call the exposed runtime methods + the API.
 *
 * SUBMIT: encrypt+upload the photo, seal its per-file key to each recipient
 * (manager + submitter) device, attach the pointer, store the sealed blobs, grant
 * download access. VIEW: fetch this device's sealed blob, unseal it, download +
 * decrypt the ciphertext, write a temp file to render.
 *
 * The photo is read from its file:// / content:// uri at upload time (NOT held as
 * a base64 string in screen state) — a multi-MB base64 in React state was enough
 * to get the host activity reclaimed under memory pressure on low-RAM devices,
 * which "refreshed" the in-progress report.
 *
 * v1 seals to / fetches from the PRIMARY device (Signal default deviceId 1) — the
 * same device id chat addresses every peer with. Real multi-device fan-out is E5.
 *
 * Diagnostics: every failure surfaces a `reason` to the caller AND logs a
 * non-secret `[bravo.incident-evidence]` breadcrumb (step + counts + error name
 * only — never a key, iv, body, or coordinate) so a device test can pinpoint
 * where the pipeline stops.
 */
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {readUriBytes, writeTempBytes} from '@/modules/messenger/media/mediaFiles';
import {incidentApi} from '@services/api';

const EVIDENCE_DEVICE_ID = 1;
const TAG = '[bravo.incident-evidence]';

export type EvidenceReason =
  | 'no-runtime'      // production seam not available on this build/session
  | 'read-failed'     // couldn't read the picked file into bytes
  | 'too-big'         // over the 50 MB server cap (post-read backstop, Item H)
  | 'upload-failed'   // encrypt+upload (presign / PUT) failed — likely storage config
  | 'attach-failed'   // server rejected the attachment pointer
  | 'no-recipient-keys'; // upload+attach ok but no recipient identity could be sealed

export interface EvidenceResult {
  attached: boolean;   // the encrypted object + pointer reached the server
  sealedFor: number;   // how many recipients got a sealed key (>0 = a viewer can open)
  reason?: EvidenceReason;
}

/** True only on a production runtime that exposes the evidence seam (not loopback). */
async function evidenceRuntime() {
  const rt = await getMessengerRuntime('production');
  if (!rt.uploadEvidence || !rt.sealOuterTo || !rt.grantMediaAccess) {return null;}
  return rt;
}

function errName(e: unknown): string {
  if (e && typeof e === 'object') {
    const status = (e as {status?: number}).status;
    const name = (e as {name?: string}).name ?? 'Error';
    return status ? `${name}(${status})` : name;
  }
  return 'Error';
}

/**
 * Encrypt + upload the photo, seal its key to every recipient, attach + store the
 * sealed blobs + grant download access. Never throws — returns an EvidenceResult
 * whose `reason` tells the caller (and the user) exactly where it stopped, so a
 * partial/failed attach is visible instead of a silent success.
 */
export async function uploadAndSealEvidence(
  incidentId: string, uri: string, mimeType: string,
): Promise<EvidenceResult> {
  const rt = await evidenceRuntime();
  if (!rt) {
    console.warn(`${TAG} runtime seam unavailable — evidence skipped`);
    return {attached: false, sealedFor: 0, reason: 'no-runtime'};
  }

  let bytes: Uint8Array;
  try {
    bytes = await readUriBytes(uri);
  } catch (e) {
    console.warn(`${TAG} read-failed ${errName(e)}`);
    return {attached: false, sealedFor: 0, reason: 'read-failed'};
  }
  // POST-READ SIZE BACKSTOP (edge review, 2026-08-08): the picker's fileSize
  // gate is advisory — some pickers/SAF providers report no size at all, and
  // some OEMs ignore durationLimit — so an unbounded file could otherwise be
  // fully encrypted AND uploaded before the server's ciphertext cap rejected
  // it. The RAM spike from readUriBytes has already happened by here (that
  // needs a pre-read stat to avoid — stated, not solved); this at least kills
  // the wasted encrypt+upload. 49 = the v2 ciphertext overhead.
  if (bytes.byteLength > 50 * 1024 * 1024 - 49) {
    console.warn(`${TAG} too-big ${bytes.byteLength}B`);
    return {attached: false, sealedFor: 0, reason: 'too-big'};
  }

  let objectKey: string;
  let body: string;
  try {
    const up = await rt.uploadEvidence!(bytes, mimeType);
    objectKey = up.objectKey;
    body = JSON.stringify({keyB64: up.keyB64, ivB64: up.ivB64, mime: mimeType});
  } catch (e) {
    console.warn(`${TAG} upload-failed ${errName(e)} (${bytes.byteLength}B)`);
    return {attached: false, sealedFor: 0, reason: 'upload-failed'};
  }

  let attachmentId: string;
  try {
    const {data: att} = await incidentApi.attach(incidentId, objectKey);
    attachmentId = att.id;
  } catch (e) {
    console.warn(`${TAG} attach-failed ${errName(e)}`);
    return {attached: false, sealedFor: 0, reason: 'attach-failed'};
  }

  const {data: recipients} = await incidentApi.evidenceRecipients(incidentId);
  const keys: {recipient_user_id: string; device_id: number; sealed_key: string}[] = [];
  let sealFails = 0;
  for (const uid of recipients) {
    try {
      const sealed = await rt.sealOuterTo!(uid, EVIDENCE_DEVICE_ID, body);
      keys.push({recipient_user_id: uid, device_id: EVIDENCE_DEVICE_ID, sealed_key: sealed});
    } catch (e) {
      // Recipient's identity unavailable (not yet provisioned / multi-device).
      sealFails += 1;
      console.warn(`${TAG} seal skip ${errName(e)}`);
    }
  }
  console.log(`${TAG} attached objectKey ok · recipients=${recipients.length} sealed=${keys.length} failed=${sealFails}`);

  if (keys.length === 0) {
    return {attached: true, sealedFor: 0, reason: 'no-recipient-keys'};
  }
  await incidentApi.storeAttachmentKeys(incidentId, attachmentId, keys);
  await rt.grantMediaAccess!(objectKey, recipients);
  return {attached: true, sealedFor: keys.length};
}

/**
 * Resolve a renderable local file:// URI (plus its mime — Item H: video
 * attachments render through expo-video, so the caller must know WHAT it
 * decrypted; the mime already rides the sealed inner JSON, no server change)
 * for one attachment, for the current viewer (submitter or manager). Returns
 * null when this device has no sealed key (e.g. sealed before this device
 * existed) or the runtime can't decrypt — the UI shows a "can't open on this
 * device" state rather than crashing.
 */
export async function loadEvidenceUri(
  incidentId: string, attachmentId: string, storageKey: string,
): Promise<{uri: string; mime: string} | null> {
  const rt = await getMessengerRuntime('production');
  if (!rt.openOuterAsSelf || !rt.downloadMedia) {return null;}

  let sealed: string;
  try {
    const {data} = await incidentApi.getAttachmentKey(incidentId, attachmentId, EVIDENCE_DEVICE_ID);
    sealed = data.sealed_key;
  } catch (e) {
    console.warn(`${TAG} view: no key for this device ${errName(e)}`);
    return null; // 404 — no blob for this device, or not authorised
  }

  try {
    const inner = JSON.parse(await rt.openOuterAsSelf(sealed)) as {keyB64: string; ivB64: string; mime?: string};
    const decrypted = await rt.downloadMedia({objectKey: storageKey, keyB64: inner.keyB64, ivB64: inner.ivB64});
    const mime = inner.mime ?? 'image/jpeg';
    const uri = await writeTempBytes(decrypted, mime, `inc-${attachmentId}`);
    return {uri, mime};
  } catch (e) {
    console.warn(`${TAG} view: open/download failed ${errName(e)}`);
    return null; // unseal / download / decrypt failed (tampered, rotated, offline)
  }
}
