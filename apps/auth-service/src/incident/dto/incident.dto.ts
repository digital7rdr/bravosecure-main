import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID,
  Length, Max, Min, ValidateNested,
} from 'class-validator';
import {Type} from 'class-transformer';
import {
  INCIDENT_CATEGORIES, INCIDENT_SEVERITIES, INCIDENT_STATUSES,
  type IncidentCategory, type IncidentSeverity, type IncidentStatus,
} from '../incident.constants';

// Any member submits a structured incident (PDF p.11-13). The narrative fields
// are written ONCE — there is intentionally no "edit incident" DTO; manager
// activity goes through the status/note DTOs (Step 9), never back onto the report.
export class SubmitIncidentDto {
  @IsIn(INCIDENT_CATEGORIES as unknown as string[])
  category!: IncidentCategory;

  @IsIn(INCIDENT_SEVERITIES as unknown as string[])
  severity!: IncidentSeverity;

  @IsString() @Length(1, 5000)
  description!: string;

  @IsOptional() @IsString() @Length(1, 120)
  department?: string;

  @IsOptional() @IsString() @Length(1, 200)
  location_label?: string;

  // Captured only at submit (no background tracking — PDF p.16 / CLAUDE.md).
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)
  location_lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  location_lng?: number;
}

// ─── Manager workflow (Step 9) ───────────────────────────────────────────────

// Move an incident along the FSM. The FSM (incident-fsm.ts) rejects illegal hops.
export class UpdateIncidentStatusDto {
  @IsIn(INCIDENT_STATUSES as unknown as string[])
  to!: IncidentStatus;
  @IsOptional() @IsString() @Length(1, 2000)
  note?: string;
}

// Add an internal (or member-visible) note without a status change.
export class AddIncidentNoteDto {
  @IsString() @Length(1, 2000)
  note!: string;
  // Defaults internal — internal notes are NEVER returned on a member view.
  @IsOptional() @IsBoolean()
  internal?: boolean;
}

// Assign an action owner (must be in the same org).
export class AssignIncidentDto {
  @IsUUID() assignee_user_id!: string;
}

// Attach an evidence pointer (Step 10). The bytes are encrypted + uploaded to
// the media vault via the existing pipeline; only the opaque object key lands
// here. 🛑 The per-file key/iv NEVER reach this DB — they ride the sealed
// envelope path (architecture-gated). storage_key is NOT a URL.
export class AttachIncidentDto {
  @IsString() @Length(1, 512)
  storage_key!: string;
}

// Step 10 · E2 — the per-file media key (key+iv) sealed (outer-ECIES) to ONE
// recipient device's identity. The submitter posts one entry per recipient
// device after upload. 🛑 `sealed_key` is ciphertext only — never a plaintext key.
export class SealedKeyEntryDto {
  @IsUUID() recipient_user_id!: string;
  @IsInt() @Min(1) @Max(1_000_000)
  device_id!: number;
  @IsString() @Length(1, 4096)
  sealed_key!: string;
}

export class StoreAttachmentKeysDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({each: true}) @Type(() => SealedKeyEntryDto)
  keys!: SealedKeyEntryDto[];
}
