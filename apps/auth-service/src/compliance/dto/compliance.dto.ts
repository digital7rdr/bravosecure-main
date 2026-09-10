import {IsIn, IsISO8601, IsOptional, IsString, MaxLength} from 'class-validator';
import {COMPLIANCE_DOC_TYPES, type ComplianceDocType} from '../compliance.service';

export class SubmitComplianceDto {
  @IsIn(COMPLIANCE_DOC_TYPES) doc_type!: ComplianceDocType;
  @IsString() @MaxLength(8) region_code!: string;
  @IsISO8601() expires_at!: string;
  @IsOptional() @IsString() @MaxLength(256) reference?: string;
  @IsOptional() @IsString() @MaxLength(512) file_url?: string;
  @IsOptional() @IsString() @MaxLength(128) file_hash_sha256?: string;
  @IsOptional() @IsString() @MaxLength(64) cpo_user_id?: string;
}

export class RejectComplianceDto {
  @IsString() @MaxLength(1024) reason!: string;
}
