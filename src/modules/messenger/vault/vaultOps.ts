/**
 * B-86 — the host-side wiring the File Vault always specified but never
 * had: local biometric ceremony → short-lived MFA action token from
 * auth-service (`POST /auth/biometric/assert`, purpose `vault-access`)
 * → `VaultClient` encrypt-and-upload with the proof in `X-Mfa-Proof` →
 * real key material persisted in the local index.
 *
 * SECURITY (do not weaken — CLAUDE.md stop condition):
 *   - The server MfaGuard is the gate (single-use proof, ≤300 s, sub +
 *     device matched). This module only obtains and threads the proof;
 *     if the proof cannot be minted the operation FAILS CLOSED with an
 *     honest message — never a fake row (audit M-02/S1).
 *   - On production builds without a real Play Integrity attestation the
 *     assert endpoint rejects and vault moves stay disabled — that is
 *     the documented posture (keysClient.mintActionToken), not a bug.
 *   - Key material returned by the upload stays on-device in the vault
 *     index; never log it.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import {API_BASE_URL, MSG_BASE_URL} from '@utils/constants';
import {KeysHttpClient} from '../transport/keysClient';
import {VaultClient} from './vaultClient';
import {useVaultStore, type VaultFile} from './vaultStore';
import {useMessengerStore} from '../store/messengerStore';
import {tokenVault} from '@services/tokenVault';

const getToken = () => tokenVault.getAccess();

export type VaultOpFailure = {
  ok: false;
  /** `tier` — the server's M1A vault entitlement gate refused (Pro lapsed or
   *  Lite): a billing state, not an MFA failure, and the UI should show the
   *  upgrade ask rather than a security-sounding alert (B-591). */
  reason: 'no_pin' | 'cancelled' | 'mfa_unavailable' | 'tier' | 'transfer_failed' | 'company_file';
  message: string;
};

/**
 * Is this conversation one of the org's department channels?
 *
 * Reads the ADDITIVE `deptConversationIds` registry — persisted, never pruned,
 * so it over-approximates, which is exactly what a refusal wants. Falls back to
 * the `deptGroupByChannel` pointer map so a device that recorded a channel
 * before the registry existed still refuses without waiting for a re-fetch.
 *
 * The pointer map is NOT the primary source: B-206 overwrites it on a channel
 * remap, so it is pruned in practice and reading it alone would un-refuse every
 * file still filed under the old conversation id.
 */
export function isDepartmentConversation(conversationId: string): boolean {
  const s = useMessengerStore.getState();
  // The ADDITIVE registry first — it is genuinely never pruned, so it keeps
  // refusing a conversation even after B-206 remaps the channel's pointer to a
  // new id. `deptGroupByChannel` is that pointer and IS overwritten, so reading
  // it alone would un-refuse every file still filed under the old id.
  if (s.deptConversationIds?.[conversationId]) {return true;}
  // …and the pointer map as well, so a device that recorded a channel before
  // this registry existed still refuses without waiting for a re-fetch.
  for (const convoId of Object.values(s.deptGroupByChannel ?? {})) {
    if (convoId === conversationId) {return true;}
  }
  return false;
}
export type VaultMoveResult = {ok: true; objectKey: string} | VaultOpFailure;
export type VaultOpenResult = {ok: true; uri: string} | VaultOpFailure;

/**
 * B-700 (founder 2026-08-29: "it asks me each time fingerprint to move per
 * image") — a PRESENCE WINDOW over the local prompt. One successful
 * fingerprint/face buys LOCAL_CEREMONY_WINDOW_MS of silence; every move/open
 * inside it skips the prompt. A live vault unlock (the user typed their PIN
 * or passed biometrics at VaultLock within its own 5-minute window) counts
 * as the same presence proof.
 *
 * SECURITY UNCHANGED where it matters: the server-side MFA action token is
 * still minted PER OPERATION (single-use, replay-guarded — the documented
 * File Vault gate, vaultOpenCeremony pins it). This window only stops the
 * UX of re-proving presence ten times in one minute. 5 minutes matches the
 * vault's own UNLOCK_WINDOW_MS and the action-token TTL posture. Dual
 * wall+monotonic clocks for the same audit-#37 rollback reason as the store.
 */
const LOCAL_CEREMONY_WINDOW_MS = 5 * 60 * 1000;
let lastCeremonyWall: number | null = null;
let lastCeremonyMono: number | null = null;

function ceremonyMonoNow(): number {
  const p = (globalThis as unknown as {performance?: {now?: () => number}}).performance;
  return typeof p?.now === 'function' ? p.now() : Date.now();
}

function ceremonyFresh(): boolean {
  if (lastCeremonyWall === null || lastCeremonyMono === null) {return false;}
  const wall = Date.now() - lastCeremonyWall;
  const mono = ceremonyMonoNow() - lastCeremonyMono;
  return wall >= 0 && wall < LOCAL_CEREMONY_WINDOW_MS
      && mono >= 0 && mono < LOCAL_CEREMONY_WINDOW_MS;
}

/** Test hook — the window is module state and suites must start cold. */
export function __resetVaultCeremonyForTests(): void {
  lastCeremonyWall = null;
  lastCeremonyMono = null;
}

/**
 * Local user-presence ceremony. Devices without biometric hardware /
 * enrollment fall through to the vault's PIN gate + the server-side
 * attestation check — the cryptographic gate is the action token, not
 * this prompt. An explicit user CANCEL aborts the operation.
 */
async function runLocalBiometric(prompt: string): Promise<boolean> {
  // B-700 — presence already proven recently (a prior prompt in this window,
  // or a live VaultLock unlock). The action token below is still per-op.
  // Optional-called: test doubles that model less than the store must fail
  // toward PROMPTING, never toward throwing out of the ceremony.
  if (ceremonyFresh() || useVaultStore.getState().isUnlocked?.() === true) {return true;}
  try {
    const [hasHw, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!hasHw || !enrolled) {return true;}
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      cancelLabel:   'Cancel',
    });
    if (res.success) {
      // Only a REAL success arms the window — never a cancel, never the
      // no-hardware fall-through (no presence was proven there).
      lastCeremonyWall = Date.now();
      lastCeremonyMono = ceremonyMonoNow();
    }
    return res.success;
  } catch {
    // Prompt infrastructure failure ≠ user refusal; the action token is
    // the real gate.
    return true;
  }
}

async function mintVaultProof(): Promise<{proof: string} | {proof: null; denied: 'tier' | 'other'; detail?: string}> {
  const keys = new KeysHttpClient({
    baseUrl:  API_BASE_URL,
    getToken,
    refreshToken: async () => {
      const {refreshAccessTokenShared} = require('@/services/api') as typeof import('@/services/api');
      await refreshAccessTokenShared();
    },
  });
  // B-697 — the mint was single-shot, so every transient blip (a dropped
  // socket, a token refresh race) wore the security dialog. One retry after
  // a short beat; minting is idempotent and an abandoned token just expires.
  // Tier refusals are FINAL for this attempt — never retried.
  let res = await keys.mintActionToken('vault-access');
  if (!res?.actionToken && res?.denied !== 'tier') {
    await new Promise<void>(r => setTimeout(r, 500));
    res = await keys.mintActionToken('vault-access');
  }
  if (res?.actionToken) {return {proof: res.actionToken};}
  return {
    proof: null,
    denied: res?.denied === 'tier' ? 'tier' : 'other',
    detail: res && res.denied === 'other' ? res.detail
          : res?.denied === 'attestation' ? 'attestation_failed'
          : undefined,
  };
}

const MFA_UNAVAILABLE_MSG =
  'The server declined the vault MFA challenge for this build, so the file was NOT moved. '
  + 'The vault gate stays closed rather than pretending to encrypt.';

// B-591 — a lapsed Pro used to surface as the MFA message above, which reads
// like a security incident. It is a billing state, and saying so is what lets
// the UI offer the plans screen instead of a dead end.
const TIER_LAPSED_MSG =
  'Secure Cloud Vault needs an active Pro plan (or an organisation account). '
  + 'Your plan is Lite or has lapsed, so the file was NOT moved.';

// B-697 — the short technical reason rides in the dialog body. On the
// founder's device the request never REACHED the server, and the uniform
// message hid that for three builds; naming the failing leg ("TypeError:
// Network request failed", "http_401:token_revoked") is what lets the next
// screenshot diagnose itself. Codes/status only — never a token or key.
const proofFailure = (denied: 'tier' | 'other', detail?: string): VaultOpFailure => (denied === 'tier'
  ? {ok: false, reason: 'tier', message: TIER_LAPSED_MSG}
  : {
      ok: false,
      reason: 'mfa_unavailable',
      message: MFA_UNAVAILABLE_MSG + (detail ? `\n\nTechnical reason: ${detail}` : ''),
    });

/**
 * Encrypt-and-upload plaintext bytes into the vault and index the
 * returned key material. `sourceKey` is the dedup handle (`msg:<id>` for
 * chat attachments, `local:<ts>` for direct uploads).
 */
export async function moveBytesToVault(params: {
  sourceKey: string;
  name:      string;
  mimeType:  string;
  bytes:     Uint8Array;
  /**
   * Scope v2 Phase 4 — WHERE THE BYTES CAME FROM. Required, and `null` only
   * for a genuinely local pick (camera / document picker), so every caller has
   * to state provenance rather than inherit a default.
   */
  conversationId: string | null;
}): Promise<VaultMoveResult> {
  // THE CHOKE POINT for "personal files and company files, never mixed".
  //
  // Copying a company file into the PERSONAL vault creates a copy that is no
  // longer membership-scoped: it survives removal from the channel and outlives
  // the permission inheritance that is the company shelf's entire access model.
  //
  // Enforced HERE rather than at each button, because there are four ways in —
  // FileViewer, the Files row shield, the Files batch lane, and the chat
  // viewer — and the first fix only covered one of them. Every one of those
  // paths ends at this function, so this is the one place the rule cannot be
  // forgotten by a new caller.
  //
  // Uses the device-local ADDITIVE registry, deliberately, not the server
  // membership list: it is never pruned, so it over-approximates the user's
  // channels. For a REFUSAL that asymmetry is the safe direction — refusing a
  // stale department conversation costs nothing, while missing one leaks a copy
  // that outlives the membership. (Deciding what to SHOW uses the narrow server
  // list instead; see companyShelf.ts.)
  //
  // NOT the deptGroupByChannel pointer map: B-206 OVERWRITES that on a channel
  // remap, so it is pruned in practice, and reading it alone would un-refuse
  // every file still filed under the old conversation id.
  if (params.conversationId && isDepartmentConversation(params.conversationId)) {
    return {
      ok: false,
      reason: 'company_file',
      message: 'Company files stay in your organisation\'s workspace. They can\'t be copied into your personal vault.',
    };
  }
  const store = useVaultStore.getState();
  if (!store.hasPin()) {
    return {ok: false, reason: 'no_pin', message: 'Set up your File Vault PIN first (Messenger → Vault), then try again.'};
  }
  if (!(await runLocalBiometric('Confirm to move this file into your vault'))) {
    return {ok: false, reason: 'cancelled', message: 'Vault move cancelled.'};
  }
  const minted = await mintVaultProof();
  if (minted.proof === null) {
    return proofFailure(minted.denied, minted.detail);
  }
  const proof = minted.proof;
  const client = new VaultClient({
    baseUrl: MSG_BASE_URL,
    getToken,
    // signalDeviceId is hardcoded to 1 across the app (Phase-1 single-device).
    signalDeviceId: 1,
  });
  try {
    const up = await client.uploadEncrypted(params.bytes, params.mimeType, proof);
    if (!up.keyB64 || !up.ivB64 || !up.objectKey) {
      // M-02 invariant — never persist a row without real key material.
      return {ok: false, reason: 'transfer_failed', message: 'Vault upload returned no key material — nothing was saved.'};
    }
    useVaultStore.getState().addFile({
      objectKey: up.objectKey,
      sourceKey: params.sourceKey,
      keyB64:    up.keyB64,
      ivB64:     up.ivB64,
      name:      params.name,
      size:      up.size,
      mimeType:  params.mimeType,
      createdAt: Date.now(),
    });
    // B-592 — the caller gets the new row's handle so it can offer "which
    // album?" without re-deriving the row from the store.
    return {ok: true, objectKey: up.objectKey};
  } catch (e) {
    return {
      ok: false,
      reason: 'transfer_failed',
      message: e instanceof Error ? e.message : 'Vault upload failed.',
    };
  }
}

/**
 * Download + decrypt a vault file to a viewable temp uri. Every open is
 * its own MFA ceremony — proofs are single-use by design (server replay
 * guard), so there is nothing to cache.
 */
export async function openVaultFileUri(f: VaultFile): Promise<VaultOpenResult> {
  if (!f.keyB64 || !f.ivB64) {
    return {ok: false, reason: 'transfer_failed', message: 'This entry has no key material (legacy row) — remove it and re-add the file.'};
  }
  if (!(await runLocalBiometric('Confirm to open this vault file'))) {
    return {ok: false, reason: 'cancelled', message: 'Vault open cancelled.'};
  }
  const minted = await mintVaultProof();
  if (minted.proof === null) {
    return proofFailure(minted.denied, minted.detail);
  }
  const proof = minted.proof;
  const client = new VaultClient({baseUrl: MSG_BASE_URL, getToken, signalDeviceId: 1});
  try {
    const bytes = await client.downloadAndDecrypt({
      objectKey: f.objectKey,
      keyB64:    f.keyB64,
      ivB64:     f.ivB64,
      mfaProof:  proof,
    });
    const {writeTempBytes} = require('../media/mediaFiles') as typeof import('../media/mediaFiles');
    const uri = await writeTempBytes(bytes, f.mimeType, `vault-${f.objectKey}`);
    return {ok: true, uri};
  } catch (e) {
    return {
      ok: false,
      reason: 'transfer_failed',
      message: e instanceof Error ? e.message : 'Vault download failed.',
    };
  }
}

/** Vault index row matching a source handle (new rows) or legacy objectKey. */
export function findVaultRow(files: ReadonlyArray<VaultFile>, sourceKey: string): VaultFile | null {
  return files.find(f => f.sourceKey === sourceKey || f.objectKey === sourceKey) ?? null;
}
