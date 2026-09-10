import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {Type} from 'class-transformer';

export class AckItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  envelopeId!: string;

  /**
   * Audit P0-N9 possession proof — REQUIRED on the batch path. There is
   * no legacy-client rollout window here (the endpoint ships with the
   * clients that call it), so batch acks are strictly token-only.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  ackToken!: string;

  @IsOptional()
  @IsIn(['delivered', 'discarded'])
  disposition?: 'delivered' | 'discarded';
}

export class AckBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({each: true})
  @Type(() => AckItemDto)
  acks!: AckItemDto[];
}
