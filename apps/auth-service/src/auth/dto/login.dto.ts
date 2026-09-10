import {IsEmail, IsString, MinLength, Matches, IsOptional, ValidateIf} from 'class-validator';

export class LoginDto {
  @IsOptional() @IsEmail()                           email?:     string;
  @IsOptional() @Matches(/^\+\d{7,15}$/)             phoneE164?: string;
  @IsString()   @MinLength(1)                        password!:  string;
}
