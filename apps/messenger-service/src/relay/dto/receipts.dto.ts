import {
  ArrayMaxSize,
  IsArray,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {Type} from 'class-transformer';

/**
 * OM-03 — batched delivery-receipt read. Capability auth only (the
 * retract token per item); no caller identity is used or recorded.
 * A wrong token and an unknown envelope produce the same `'unknown'`
 * outcome at the service layer, so the endpoint is not a delivery
 * oracle for guessed envelope ids.
 */
export class ReceiptQueryItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  envelopeId!: string;

  /** Same shape gate as `POST /envelopes/retract` (relay-minted UUID). */
  @IsString()
  @Matches(/^[0-9a-f-]{36}$/i)
  retractToken!: string;
}

export class ReceiptsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({each: true})
  @Type(() => ReceiptQueryItemDto)
  items!: ReceiptQueryItemDto[];
}
