import {IsString, MinLength, MaxLength, IsIn} from 'class-validator';

export class AssertDto {
  @IsString() @MinLength(1)                  attestationToken!: string;
  @IsIn(['android','ios'])                   platform!:         'android' | 'ios';
  @IsString() @MinLength(1) @MaxLength(64)   purpose!:          string;
}
