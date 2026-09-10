export {
  VaultClient,
  VaultHttpError,
  type VaultClientOptions,
  type VaultUploadResult,
} from './vaultClient';

export {
  useVaultStore,
  vaultHydrated,
  vaultPersistApi,
  adoptVaultOwnerWhenReady,
  type VaultFile,
  type VaultOwnerStash,
} from './vaultStore';
export {openVault} from './navigation';
export {armVaultIndexSync, disarmVaultIndexSync, maybeRestoreVaultIndex} from './vaultIndexSync';
export {
  moveBytesToVault,
  isDepartmentConversation,
  openVaultFileUri,
  findVaultRow,
  type VaultMoveResult,
  type VaultOpenResult,
} from './vaultOps';
