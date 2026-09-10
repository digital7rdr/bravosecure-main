import {IsBase64, IsInt, MaxLength, Min} from 'class-validator';

/** B-696 Phase D — opaque E2E-encrypted vault index upload. The cap mirrors
 *  VaultIndexService.MAX_BLOB_B64 (2 MiB base64 ≈ 1.5 MiB ciphertext). */
export class PutVaultIndexDto {
  @IsBase64() @MaxLength(2 * 1024 * 1024) blob!: string;
  @IsInt() @Min(0) seq!: number;
}
