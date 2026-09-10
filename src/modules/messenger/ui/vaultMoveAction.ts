/**
 * Audit M-02 (same class as S1) — the viewer's "Move to Vault" used to
 * persist a VaultFile{keyB64: '', ivB64: '', uri: <plaintext temp file>}
 * row, pretending encryption had happened, and was therefore gated to
 * fail closed.
 *
 * B-86 (2026-07-16) — the real encrypt-and-upload pipeline is now wired
 * (vault/vaultOps.ts: biometric ceremony → single-use MFA action token →
 * VaultClient upload → real key material persisted), so `add` is allowed
 * again — but ONLY through that pipeline: the M-02 fail-closed invariant
 * moved into vaultStore.addFile, which refuses any row without real
 * key material, and vaultOps returns an honest failure instead of
 * writing anything when the MFA proof can't be minted.
 *
 * Kept as a free function (no RN imports) so the messenger-crypto Jest
 * project can lock the invariant without rendering the component.
 */
export type VaultMoveAction =
  | {kind: 'remove'; objectKey: string}
  | {kind: 'add'};

export function resolveVaultMoveAction(
  _fileId: string,
  /** The matched index row's objectKey when the file is already vaulted, else null. */
  inVaultObjectKey: string | null,
): VaultMoveAction {
  if (inVaultObjectKey) {
    return {kind: 'remove', objectKey: inVaultObjectKey};
  }
  return {kind: 'add'};
}
