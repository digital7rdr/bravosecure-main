/**
 * Local-file <-> bytes bridge for the encrypted-attachment pipeline.
 *
 *   readUriBytes(uri)        — read a picked file (file:// or content://)
 *                              into a Uint8Array, ready for encrypt+upload.
 *   writeTempBytes(bytes,..) — write decrypted plaintext to a cache file
 *                              and return a file:// uri the native <Image>
 *                              / FileViewer can render. Caller owns cleanup.
 *
 * Plaintext bytes are only ever held in memory or in the app-private
 * cache dir (SQLCipher/keychain-protected device; cache is wiped on
 * uninstall). The decrypted temp file is the unavoidable cost of letting
 * the OS image/video/audio decoders read a uri — there is no API to feed
 * raw bytes to <Image>. We keep it in the private cache, not shared
 * storage, so other apps can't read it.
 */

import RNFS from 'react-native-fs';
import {Buffer} from '@craftzdog/react-native-buffer';

/**
 * Read a picked file uri into bytes. Handles both `file://` paths and
 * Android `content://` SAF uris (react-native-fs reads both on Android;
 * on iOS the picker hands back file:// already).
 */
export async function readUriBytes(uri: string): Promise<Uint8Array> {
  // RNFS.readFile with 'base64' is the portable path — it works for
  // content:// uris that a plain fs path read would reject. We decode the
  // base64 to bytes with the same Buffer polyfill the rest of the crypto
  // layer uses.
  //
  // [LAGDIAG] TEMPORARY (B-285) — split the native file read from the JS base64
  // decode. The read is async and off-thread; `Buffer.from(b64,'base64')` is
  // SYNCHRONOUS on the JS thread over a multi-MB string, which is the prime
  // suspect for the 4-6s freezes MIUI's PerfMonitor reported on
  // MessageQueueThreadHandler. Measure before assuming.
  const t0 = Date.now();
  const b64 = await RNFS.readFile(uri, 'base64');
  const t1 = Date.now();
  const out = new Uint8Array(Buffer.from(b64, 'base64'));
  const t2 = Date.now();
  if (t2 - t0 > 200) {
    console.warn(`[LAGDIAG] readUriBytes ${(out.length / 1048576).toFixed(2)}MB read=${t1 - t0}ms b64decode=${t2 - t1}ms`);
  }
  return out;
}

/**
 * B-457 — the temp-cache filename must be INJECTIVE over idHint.
 *
 * The old rule was `idHint.replace(/[^a-zA-Z0-9_-]/g,'').slice(0, 40)`, and
 * `writeTempBytes` skips the write when the path already exists. So any two
 * idHints sharing a 40-char sanitised prefix resolved to ONE file and the
 * second caller was handed the FIRST caller's decrypted plaintext. The vault
 * hit it on every file: keys are `vault/<ownerUuid>/<fileUuid>` and the hint is
 * `vault-<objectKey>`, so the budget ran out inside the owner id and the
 * per-file uuid — the only distinguishing part — was truncated away.
 *
 * Fix: keep a readable (and still filesystem-safe) prefix for debuggability,
 * then append a short hash of the FULL ORIGINAL hint, so characters past the
 * truncation point still change the name. Length budget is unchanged at 48.
 *
 * Every path helper below derives its name from HERE — the reader
 * (`statTempBytes`) and the plaintext cleaner (`deleteTempBytes`) have to agree
 * with the writer or a fix to one of them just moves the bug.
 */
function tempStem(idHint: string): string {
  const raw  = idHint ?? '';
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 31) || 'att';
  return `${safe}-${stemHash(raw)}`;
}

/**
 * Two-lane FNV-1a, 64 bits of output. NOT a security primitive and it does not
 * need to be — nothing trusts this value, it only has to keep two distinct
 * cache keys apart. Kept dependency-free and synchronous because it runs on
 * the JS thread for every attachment mount (see the [LAGDIAG] notes above).
 */
function stemHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Write decrypted plaintext bytes to a uniquely-named file in the app's
 * private cache directory and return its file:// uri. The extension is
 * derived from the mime so the OS decoder picks the right handler.
 *
 * `idHint` (the message id) keys the filename so re-decrypting the same
 * attachment reuses the same path instead of piling up temp files.
 */
export async function writeTempBytes(
  bytes: Uint8Array,
  mimeType: string,
  idHint: string,
): Promise<string> {
  const ext  = extForMime(mimeType);
  const path = `${RNFS.CachesDirectoryPath}/bravo-media-${tempStem(idHint)}${ext}`;
  const exists = await RNFS.exists(path);
  if (!exists) {
    const b64 = Buffer.from(bytes).toString('base64');
    await RNFS.writeFile(path, b64, 'base64');
  }
  return `file://${path}`;
}

/**
 * Media-parity G4 (2026-07-03) — fast path: return the decrypted temp
 * file's uri when it already exists, WITHOUT touching bytes. The file
 * is the product of a prior authenticated (HMAC-verified) decrypt of
 * this exact message, so re-running the download+verify+decrypt+encode
 * pipeline just to arrive at the same path was pure waste — it ran on
 * every bubble mount and again when the viewer opened. Callers try
 * this first and only fall into the full pipeline on a miss.
 */
export async function statTempBytes(
  mimeType: string,
  idHint: string,
): Promise<string | null> {
  const ext  = extForMime(mimeType);
  const path = `${RNFS.CachesDirectoryPath}/bravo-media-${tempStem(idHint)}${ext}`;
  try {
    return (await RNFS.exists(path)) ? `file://${path}` : null;
  } catch {
    return null;
  }
}

/**
 * Audit MEDIA-A2 (2026-07-02): delete the decrypted-plaintext cache file(s)
 * for a message id. writeTempBytes leaves plaintext in the private cache dir
 * ("caller owns cleanup"), but nothing deleted it — so a disappearing message
 * that burned (bubble + ciphertext-cache + R2 all purged) still left its
 * DECRYPTED plaintext on disk until the OS trimmed the cache. Called from the
 * store-removal subscriber and the expiry sweeper. Best-effort, never throws.
 */
export async function deleteTempBytes(idHint: string): Promise<void> {
  const prefix = `bravo-media-${tempStem(idHint)}`;
  // B-457 transition — files written by a build that used the old
  // `slice(0, 40)` stem carry a different name, so the current rule would walk
  // straight past them and leave decrypted plaintext on disk forever. Sweep the
  // legacy name too. It can only ever match a legacy file: a current name has
  // `-<16 hex>` where the legacy prefix would need a `.` or end-of-name.
  const legacy = `bravo-media-${(idHint ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'att'}`;
  const hit = (name: string, p: string) => name === p || name.startsWith(`${p}.`);
  try {
    const entries = await RNFS.readDir(RNFS.CachesDirectoryPath);
    await Promise.all(
      entries
        .filter(e => e.isFile() && (hit(e.name, prefix) || hit(e.name, legacy)))
        .map(e => RNFS.unlink(e.path).catch(() => undefined)),
    );
  } catch { /* cache dir unreadable — best effort */ }
}

/**
 * B-149 — delete a plaintext SOURCE file the app itself produced (today:
 * the expo-av voice-note recording) once its bytes have been read and
 * encrypted.
 *
 * `deleteTempBytes` above only knows the `bravo-media-<id>` decrypted-VIEW
 * files; it has no idea where the recorder put its capture, so the user's
 * own unencrypted audio sat in the app cache until the OS trimmed it —
 * squarely against this module's "plaintext only in the private cache,
 * caller owns cleanup" contract.
 *
 * DELIBERATELY NARROW. It refuses anything that is not a `file://` path
 * inside the app's own Caches/Documents/Temporary directories, because the
 * obvious generalisation — "delete the asset after upload" — would unlink
 * LIBRARY picks, i.e. delete the user's photo out of their gallery. Only
 * pass a URI the app created. Best-effort, never throws.
 */
export async function deleteEphemeralSource(uri: string): Promise<void> {
  if (!uri?.startsWith('file://')) {return;}
  let path: string;
  try {
    path = decodeURI(uri.replace('file://', ''));
  } catch {
    return;
  }
  const ownedRoots = [
    RNFS.CachesDirectoryPath,
    RNFS.DocumentDirectoryPath,
    RNFS.TemporaryDirectoryPath,
  ].filter((r): r is string => typeof r === 'string' && r !== '');
  if (!ownedRoots.some(root => path.startsWith(root))) {return;}
  try {
    await RNFS.unlink(path);
  } catch { /* already gone / not a file — best effort */ }
}

function extForMime(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') {return '.jpg';}
  if (m === 'image/png')  {return '.png';}
  if (m === 'image/gif')  {return '.gif';}
  if (m === 'image/webp') {return '.webp';}
  if (m === 'video/mp4')  {return '.mp4';}
  if (m === 'video/quicktime') {return '.mov';}
  if (m === 'video/webm') {return '.webm';}
  if (m === 'video/3gpp') {return '.3gp';}
  if (m === 'audio/mp4' || m === 'audio/m4a' || m === 'audio/x-m4a') {return '.m4a';}
  if (m === 'audio/mpeg') {return '.mp3';}
  if (m === 'audio/ogg')  {return '.ogg';}
  if (m === 'audio/wav' || m === 'audio/x-wav') {return '.wav';}
  if (m === 'audio/aac')  {return '.aac';}
  if (m === 'application/pdf') {return '.pdf';}
  if (m === 'text/plain') {return '.txt';}
  if (m === 'application/zip') {return '.zip';}
  if (m === 'application/msword') {return '.doc';}
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {return '.docx';}
  if (m === 'application/vnd.ms-excel') {return '.xls';}
  if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {return '.xlsx';}
  if (m === 'application/vnd.ms-powerpoint') {return '.ppt';}
  if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {return '.pptx';}
  // Media-parity M14 — unknown mimes used to produce an EXTENSIONLESS
  // temp file, which external viewers (FileViewer/ACTION_VIEW resolvers
  // pick handlers by extension) could rarely open. '.bin' at least lets
  // the "open with…" chooser appear.
  return '.bin';
}
