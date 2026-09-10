import {IsString, MinLength, MaxLength, IsBoolean, IsOptional} from 'class-validator';

export class SessionDeleteDto {
  @IsString() @MinLength(1) @MaxLength(128) deviceId!:   string;
  @IsOptional() @IsBoolean()                allDevices?: boolean;
}
