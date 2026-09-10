import {IsInt, IsString, Matches, Min, Max, MinLength, MaxLength} from 'class-validator';

export class CreateUploadUrlDto {
  @IsInt() @Min(1) @Max(50 * 1024 * 1024)
  contentLength!: number;

  /** MIME type, e.g. `application/octet-stream` for opaque encrypted blobs. */
  @IsString() @MinLength(3) @MaxLength(100)
  @Matches(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)
  contentType!: string;
}
