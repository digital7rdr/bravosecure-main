import {IsInt, IsString, Matches, Max, MaxLength, Min, MinLength} from 'class-validator';

export class CreateVaultUploadDto {
  @IsInt() @Min(1) @Max(50 * 1024 * 1024)
  contentLength!: number;

  @IsString() @MinLength(3) @MaxLength(100)
  @Matches(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)
  contentType!: string;
}
