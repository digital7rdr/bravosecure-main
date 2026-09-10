import {IsInt, IsString, Min, Max, IsArray, ArrayMaxSize, ValidateNested, IsOptional} from 'class-validator';
import {Type} from 'class-transformer';

class OneTimePrekey {
  @IsInt() keyId!: number;
  @IsString() publicKey!: string;
}

export class UploadKeysDto {
  @IsInt() @Min(0) @Max(0x3fff) registrationId!:  number;
  @IsString()                   identityKey!:     string;
  @IsInt()                      signedPrekeyId!:  number;
  @IsString()                   signedPrekey!:    string;
  @IsString()                   signedPrekeySig!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @ValidateNested({each: true}) @Type(() => OneTimePrekey)
  oneTimePrekeys?: OneTimePrekey[];
}
